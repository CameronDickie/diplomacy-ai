variable "aws_region" {
  description = "AWS region for Lightsail resources."
  type        = string
  default     = "us-east-2"
}

variable "site_domain" {
  description = "Public subdomain served by the Diplomacy app."
  type        = string
  default     = "diplomacy.camerondickie.ca"
}

variable "hosted_zone_name" {
  description = "Existing Route 53 hosted zone name."
  type        = string
  default     = "camerondickie.ca."
}

variable "instance_name" {
  description = "Lightsail instance name."
  type        = string
  default     = "diplomacy"
}

variable "availability_zone" {
  description = "Lightsail availability zone."
  type        = string
  default     = "us-east-2a"
}

variable "bundle_id" {
  description = "Lightsail instance bundle."
  type        = string
  default     = "small_3_0"
}

variable "blueprint_id" {
  description = "Lightsail OS blueprint."
  type        = string
  default     = "ubuntu_24_04"
}

variable "ssh_public_key_path" {
  description = "Local public SSH key to register with Lightsail."
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}

variable "app_dir" {
  description = "Directory on the Lightsail instance used by the deploy script."
  type        = string
  default     = "/srv/diplomacy"
}

variable "ssh_user" {
  description = "Default SSH user for the selected Lightsail blueprint."
  type        = string
  default     = "ubuntu"
}

variable "tags" {
  description = "Tags applied to supported AWS resources."
  type        = map(string)
  default = {
    Project   = "diplomacy"
    ManagedBy = "terraform"
  }
}

