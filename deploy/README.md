# Framer AWS deployment

Framer uses one `t3.small` EC2 instance with standard CPU credits and an encrypted 20 GB root disk. API, worker and PostgreSQL 17 with pgvector run on that host. Original videos use a separate private S3 bucket. Cloudflare handles the public HTTPS hostname. There is no RDS, SQS, load balancer, NAT gateway or Elastic IP.

## Provision and deploy

1. Verify the account is on an active AWS FREE plan with enough remaining credits. Never upgrade the account to a paid plan as part of this setup.
2. `python scripts/provision_framer.py --apply` creates manifest-scoped infrastructure. State and SSH keys live in ignored `data/framer-deploy/`; keep this directory private. If creation fails midway, inspect that manifest and resume existing resources rather than creating duplicates.
3. Run `deploy/bootstrap_ubuntu.sh` over SSH on the new Ubuntu host.
4. `scripts/deploy_framer.sh HOST SSH_KEY` transfers code and a filtered environment over SSH. It requires authorization to send the existing Gemini API key to the chosen host. It copies no previous video library or database.
5. Enable and start `framer-api`, `framer-worker`, `framer-free-plan.timer` and `framer-expiration.timer` after checking configuration. PostgreSQL uses local socket peer authentication; AWS uses the instance role.
6. Verify `/health`, a fresh empty library, then upload/query/delete behavior through the public hostname.

The public configuration limits uploads to 400 MB, 10 uploads/day and 100 queries/day. Legacy synchronous upload routes are disabled. S3 CORS allows the Framer hostname; the origin firewall permits Cloudflare and the operator IP only.

## Free-plan protection

Provisioning refuses non-FREE, inactive or exhausted plans. The instance's daily guard stops it if plan lookup fails, coverage is no longer FREE/ACTIVE, credits fall below $5, or expiration is reached. A separate fixed-date timer stops it at the known plan expiration. These are cost controls, not a usage meter or billing guarantee. Credits are consumed; stopping EC2 does not remove disk or S3 storage. Do not upgrade to paid billing without explicitly reviewing running resources.

Video lifecycle deletion is applied only after explicit retention authorization. Without it, remove unwanted objects explicitly from the private S3 bucket and monitor storage.

## Operations

- Services: `sudo systemctl status framer-api framer-worker`
- Logs: `sudo journalctl -u framer-api -u framer-worker`
- Guard schedule: `sudo systemctl list-timers 'framer-*'`
- Stop compute: `sudo shutdown -h now` (instance shutdown behavior is **stop**, preserving data).

For full cleanup, use the exact instance, security group, IAM role/profile, key pair and bucket recorded in `data/framer-deploy/manifest.json`. Terminating the instance deletes its root disk. Bucket deletion requires a separate decision about retained videos. Never delete unrelated account resources.

`provision_demo.py`, `deploy_demo.sh` and `irl-*` units are retained legacy assessment helpers, not the Framer deployment path.
