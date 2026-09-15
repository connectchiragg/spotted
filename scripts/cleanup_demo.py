"""Delete only temporary resources explicitly recorded in the demo manifest."""
import json
from pathlib import Path
import boto3


def main():
    path=Path(__file__).resolve().parents[1]/'data/deploy/manifest.json'
    state=json.loads(path.read_text())
    if state.get('cleaned_up'):
        print('Already cleaned up')
        return
    session=boto3.Session(profile_name='default',region_name=state['region'])
    ec2,iam=session.client('ec2'),session.client('iam')
    if state.get('instance_id'):
        ec2.terminate_instances(InstanceIds=[state['instance_id']])
        ec2.get_waiter('instance_terminated').wait(InstanceIds=[state['instance_id']])
    if state.get('security_group'):
        ec2.delete_security_group(GroupId=state['security_group'])
    if state.get('key_pair'):
        ec2.delete_key_pair(KeyName=state['key_pair'])
    if state.get('instance_profile'):
        iam.remove_role_from_instance_profile(InstanceProfileName=state['instance_profile'],RoleName=state['role'])
        iam.delete_instance_profile(InstanceProfileName=state['instance_profile'])
    if state.get('role'):
        iam.delete_role_policy(RoleName=state['role'],PolicyName='DemoBucketOnly')
        iam.delete_role(RoleName=state['role'])
    state['cleaned_up']=True
    path.write_text(json.dumps(state,indent=2))
    print('Temporary demo removed; existing S3 bucket untouched')


if __name__=='__main__':
    main()
