"""Spotted infrastructure provisioning guarded by the AWS Free Plan."""
import argparse
import ipaddress
import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path
import boto3
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'data/spotted-deploy/manifest.json'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply',action='store_true',help='Create resources only after explicit approval')
    args=parser.parse_args()
    load_dotenv(ROOT / '.env')
    session = boto3.Session(profile_name='default', region_name='ap-south-1')
    plan = session.client('freetier', region_name='us-east-1').get_account_plan_state()
    if not (plan['accountPlanType'] == 'FREE' and plan['accountPlanStatus'] == 'ACTIVE'
            and float(plan.get('accountPlanRemainingCredits', {}).get('amount', 0)) >= 5):
        raise SystemExit('Active FREE plan with remaining credit required')
    scope={'region':'ap-south-1','instance':'one t3.small CPU credits standard',
           'volume':'one encrypted 20GB gp3 root; delete on termination',
           'network':'existing default VPC; TCP8000 Cloudflare IPv4 + operator only; SSH operator IP only',
           'identity':'S3-prefix role plus read-only Free Plan check and one SSH key pair',
           'expiry':'stop on FREE plan exhaustion or expiration',
           'remaining_credits':plan['accountPlanRemainingCredits'],
           'excluded':'no RDS, load balancer, NAT gateway, Elastic IP, account upgrade, or S3 deletion'}
    print(json.dumps({'dry_run':not args.apply,'scope':scope}),flush=True)
    if not args.apply:
        return
    if MANIFEST.exists():
        raise SystemExit('Existing manifest: inspect/clean previous resources before creating new ones')
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(MANIFEST.parent, 0o700)
    name = 'spotted-' + str(int(time.time()))
    state = {'region': 'ap-south-1', 'name': name, 'expires_at': str(plan['accountPlanExpirationDate'])}
    def save():
        MANIFEST.write_text(json.dumps(state, indent=2))
        os.chmod(MANIFEST, 0o600)
    save()
    ec2, iam = session.client('ec2'), session.client('iam')
    bucket = name + '-videos'
    s3 = session.client('s3')
    s3.create_bucket(Bucket=bucket,CreateBucketConfiguration={'LocationConstraint':'ap-south-1'},ObjectOwnership='BucketOwnerEnforced')
    state['bucket']=bucket
    save()
    s3.put_public_access_block(Bucket=bucket,PublicAccessBlockConfiguration={k:True for k in ['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets']})
    s3.put_bucket_encryption(Bucket=bucket,ServerSideEncryptionConfiguration={'Rules':[{'ApplyServerSideEncryptionByDefault':{'SSEAlgorithm':'AES256'}}]})
    s3.put_bucket_cors(Bucket=bucket,CORSConfiguration={'CORSRules':[{'AllowedOrigins':['https://spotted.haciensus.com'],'AllowedMethods':['PUT','GET','HEAD'],'AllowedHeaders':['*'],'ExposeHeaders':['ETag'],'MaxAgeSeconds':600}]})
    s3.put_bucket_lifecycle_configuration(Bucket=bucket,LifecycleConfiguration={'Rules':[{'ID':'bound-demo-storage','Status':'Enabled','Filter':{'Prefix':'videos/'},'Expiration':{'Days':7},'AbortIncompleteMultipartUpload':{'DaysAfterInitiation':1}}]})
    iam.create_role(RoleName=name, AssumeRolePolicyDocument=json.dumps({'Version':'2012-10-17',
        'Statement':[{'Effect':'Allow','Principal':{'Service':'ec2.amazonaws.com'},'Action':'sts:AssumeRole'}]}))
    state['role'] = name
    save()
    iam.put_role_policy(RoleName=name, PolicyName='DemoBucketOnly', PolicyDocument=json.dumps({
        'Version':'2012-10-17','Statement':[{'Effect':'Allow','Action':['s3:GetObject','s3:PutObject','s3:DeleteObject'],
        'Resource':f'arn:aws:s3:::{bucket}/videos/*'},{'Effect':'Allow','Action':['freetier:GetAccountPlanState'],'Resource':'*'}]}))
    iam.create_instance_profile(InstanceProfileName=name)
    state['instance_profile'] = name
    save()
    iam.add_role_to_instance_profile(InstanceProfileName=name, RoleName=name)
    key = MANIFEST.parent/'key'
    subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(key)],check=True)
    os.chmod(key,0o600)
    ec2.import_key_pair(KeyName=name,PublicKeyMaterial=key.with_suffix('.pub').read_bytes())
    state.update(key_pair=name,ssh_key=str(key),ssh_user='ubuntu')
    save()
    vpcs=ec2.describe_vpcs(Filters=[{'Name':'is-default','Values':['true']}])['Vpcs']
    if not vpcs:
        raise SystemExit('No default VPC; refusing extra infrastructure')
    vpc=vpcs[0]['VpcId']
    sg=ec2.create_security_group(GroupName=name,Description='Temporary IRL demo',VpcId=vpc)['GroupId']
    state['security_group']=sg
    save()
    public_ip=urllib.request.urlopen('https://checkip.amazonaws.com',timeout=10).read().decode().strip()
    ipaddress.IPv4Address(public_ip)
    cf=json.load(urllib.request.urlopen('https://api.cloudflare.com/client/v4/ips',timeout=10))['result']['ipv4_cidrs']
    for cidr in cf: ipaddress.IPv4Network(cidr)
    ec2.authorize_security_group_ingress(GroupId=sg,IpPermissions=[
        {'IpProtocol':'tcp','FromPort':22,'ToPort':22,'IpRanges':[{'CidrIp':public_ip+'/32'}]},
        {'IpProtocol':'tcp','FromPort':8000,'ToPort':8000,'IpRanges':[{'CidrIp':cidr} for cidr in cf+[public_ip+'/32']]}])
    images=ec2.describe_images(Owners=['099720109477'],Filters=[
        {'Name':'name','Values':['ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*']},
        {'Name':'state','Values':['available']}])['Images']
    ami=max(images,key=lambda i:i['CreationDate'])
    subnets=ec2.describe_subnets(Filters=[{'Name':'vpc-id','Values':[vpc]},
        {'Name':'default-for-az','Values':['true']}])['Subnets']
    time.sleep(15)
    instance=ec2.run_instances(ImageId=ami['ImageId'],InstanceType='t3.small',MinCount=1,MaxCount=1,
        KeyName=name,IamInstanceProfile={'Name':name},CreditSpecification={'CpuCredits':'standard'},
        InstanceInitiatedShutdownBehavior='stop',MetadataOptions={'HttpTokens':'required'},
        NetworkInterfaces=[{'DeviceIndex':0,'SubnetId':subnets[0]['SubnetId'],
                            'Groups':[sg],'AssociatePublicIpAddress':True}],
        BlockDeviceMappings=[{'DeviceName':ami['RootDeviceName'],'Ebs':{'VolumeSize':20,
            'VolumeType':'gp3','Encrypted':True,'DeleteOnTermination':True}}],
        TagSpecifications=[{'ResourceType':'instance','Tags':[{'Key':'Name','Value':name},
            {'Key':'Project','Value':'Spotted'}]}],UserData='#!/bin/bash\n# Persistent Spotted; free-plan guard installed during deployment.\n')['Instances'][0]
    state['instance_id']=instance['InstanceId']
    save()
    ec2.get_waiter('instance_running').wait(InstanceIds=[state['instance_id']],WaiterConfig={'Delay':5,'MaxAttempts':30})
    instance=ec2.describe_instances(InstanceIds=[state['instance_id']])['Reservations'][0]['Instances'][0]
    state['public_ip']=instance['PublicIpAddress']
    save()
    print(json.dumps({'instance_id':state['instance_id'],'public_ip':state['public_ip'],
                     'ssh_key':str(key),'ssh_user':'ubuntu','free_plan_expiration':state['expires_at']}))


if __name__=='__main__':
    main()
