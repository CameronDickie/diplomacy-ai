output "lightsail_static_ip" {
  description = "Static public IPv4 address attached to the Lightsail instance."
  value       = aws_lightsail_static_ip.app.ip_address
}

output "ssh_target" {
  description = "SSH target for the Lightsail instance."
  value       = "${var.ssh_user}@${aws_lightsail_static_ip.app.ip_address}"
}

output "site_url" {
  description = "Public site URL."
  value       = "https://${local.normalized_site_domain}"
}

output "app_dir" {
  description = "Remote app directory used by deploy_lightsail.sh."
  value       = var.app_dir
}

output "deploy_environment" {
  description = "Environment exports for deploy_lightsail.sh."
  value = {
    LIGHTSAIL_HOST    = aws_lightsail_static_ip.app.ip_address
    LIGHTSAIL_USER    = var.ssh_user
    LIGHTSAIL_APP_DIR = var.app_dir
    SITE_DOMAIN       = local.normalized_site_domain
  }
}

