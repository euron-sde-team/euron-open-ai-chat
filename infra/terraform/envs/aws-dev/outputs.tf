output "app_url" {
  description = "Public URL of the app."
  value       = module.chat.app_url
}

output "cluster_name" {
  description = "ECS cluster."
  value       = module.chat.cluster_name
}

output "services" {
  description = "ECS service names (api, worker, web)."
  value       = module.chat.services
}

output "ecr_repositories" {
  description = "Image repositories (api, web)."
  value       = module.chat.ecr_repositories
}

output "migrate_task_definition_arn" {
  description = "One-off migration task definition."
  value       = module.chat.migrate_task_definition_arn
}

output "admin_task_definition_arn" {
  description = "One-off admin bootstrap task definition."
  value       = module.chat.admin_task_definition_arn
}

output "run_task" {
  description = "Parameters for the one-off tasks (scripts/aws-run-task.sh)."
  value       = module.chat.run_task
}

output "media_bucket" {
  description = "Media bucket."
  value       = module.chat.media_bucket
}

output "redis_endpoint" {
  description = "Redis primary endpoint."
  value       = module.chat.redis_endpoint
}

output "mail_configuration_set" {
  description = "SES configuration set."
  value       = module.chat.mail_configuration_set
}

output "load_balancer_dns_name" {
  description = "CNAME target when the zone is not in Route53."
  value       = module.chat.load_balancer_dns_name
}

output "certificate_validation_records" {
  description = "Publish by hand when the zone is not in Route53."
  value       = module.chat.certificate_validation_records
}

output "mail_dns_records" {
  description = "Publish by hand when the zone is not in Route53."
  value       = module.chat.mail_dns_records
}

output "provider_keys_secret_name" {
  description = "Secret holding PROVIDER_KEYS (replace each \"set-me\", or the whole JSON object)."
  value       = module.chat.provider_keys_secret_name
}

output "search_secret_name" {
  description = "Secret holding the hosted search keys (replace the one in use), or null."
  value       = module.chat.search_secret_name
}
