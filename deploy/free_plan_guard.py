"""Fail closed: stop this host when the Free Plan cannot cover continued use."""
import subprocess
from datetime import datetime,timezone
import boto3

try:
    plan=boto3.client('freetier',region_name='us-east-1').get_account_plan_state()
    expiration=plan.get('accountPlanExpirationDate')
    safe=(plan.get('accountPlanType')=='FREE' and plan.get('accountPlanStatus')=='ACTIVE'
          and float(plan.get('accountPlanRemainingCredits',{}).get('amount',0))>=5
          and expiration is not None and expiration>datetime.now(timezone.utc))
except Exception:
    safe=False
if not safe:
    print('Free plan guard stopping instance: free coverage unavailable or below reserve.',flush=True)
    subprocess.run(['/usr/sbin/shutdown','-h','now'],check=True)
else:
    print('Free plan guard passed.',flush=True)
