locals {
  normalized_site_domain = trimsuffix(var.site_domain, ".")
  key_pair_name          = "${var.instance_name}-deploy-key"
  static_ip_name         = "${var.instance_name}-static-ip"
}

data "aws_route53_zone" "site" {
  name         = var.hosted_zone_name
  private_zone = false
}

resource "aws_lightsail_key_pair" "deploy" {
  name       = local.key_pair_name
  public_key = file(pathexpand(var.ssh_public_key_path))
}

resource "aws_lightsail_instance" "app" {
  name              = var.instance_name
  availability_zone = var.availability_zone
  blueprint_id      = var.blueprint_id
  bundle_id         = var.bundle_id
  key_pair_name     = aws_lightsail_key_pair.deploy.name
  user_data = templatefile("${path.module}/templates/cloud-init.sh.tftpl", {
    app_dir  = var.app_dir
    ssh_user = var.ssh_user
  })
  tags = var.tags
}

resource "aws_lightsail_static_ip" "app" {
  name = local.static_ip_name
}

resource "aws_lightsail_static_ip_attachment" "app" {
  static_ip_name = aws_lightsail_static_ip.app.name
  instance_name  = aws_lightsail_instance.app.name

  lifecycle {
    replace_triggered_by = [aws_lightsail_instance.app]
  }
}

resource "aws_lightsail_instance_public_ports" "app" {
  instance_name = aws_lightsail_instance.app.name

  port_info {
    protocol  = "tcp"
    from_port = 22
    to_port   = 22
  }

  port_info {
    protocol  = "tcp"
    from_port = 80
    to_port   = 80
  }

  port_info {
    protocol  = "tcp"
    from_port = 443
    to_port   = 443
  }
}

resource "aws_route53_record" "app" {
  zone_id         = data.aws_route53_zone.site.zone_id
  name            = local.normalized_site_domain
  type            = "A"
  ttl             = 300
  records         = [aws_lightsail_static_ip.app.ip_address]
  allow_overwrite = true
}

