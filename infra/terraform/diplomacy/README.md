# Diplomacy Lightsail Terraform

This stack provisions a separate Lightsail instance for the Diplomacy app and
creates the Route 53 `A` record for `diplomacy.camerondickie.ca`.

```bash
cd infra/terraform/diplomacy
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform validate
terraform plan -out diplomacy.tfplan
terraform apply diplomacy.tfplan
```

After apply, confirm the bootstrap finished:

```bash
ssh "$(terraform output -raw ssh_target)" 'cloud-init status --wait && docker --version && ls -la /srv/diplomacy'
```

The root `deploy_lightsail.sh` script reads this stack's outputs by default.

