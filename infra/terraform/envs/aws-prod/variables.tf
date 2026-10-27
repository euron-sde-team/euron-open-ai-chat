variable "region" {
  description = "AWS region."
  type        = string
}

variable "environment" {
  description = "Environment tag."
  type        = string
  default     = "prod"
}

variable "extra_tags" {
  description = "Tags added to every resource."
  type        = map(string)
  default     = {}
}

variable "name_prefix" {
  description = "Prefix for every resource name; the bucket name derives from it, so make it globally unique (e.g. \"my-chat-prod\")."
  type        = string
}

variable "domain" {
  description = "The app host, e.g. app.example.com. Web and API (/api/*) share it."
  type        = string
}

variable "route53_zone_id" {
  description = "Hosted zone for the domain (automatic certificates and DNS)."
  type        = string
  default     = null
}

variable "certificate_arn" {
  description = "Existing regional certificate, when the zone is not in Route53."
  type        = string
  default     = null
}

variable "mail_domain" {
  description = "SES sending domain (defaults to domain)."
  type        = string
  default     = null
}

variable "image_tag" {
  description = "Image tag to deploy (make aws-deploy passes the git commit)."
  type        = string
}

variable "product_name" {
  description = "Product name shown in the app and emails."
  type        = string
  default     = "Euron Open AI Chat"
}

variable "enable_cdn" {
  description = "CloudFront (+ WAF) in front of the load balancer."
  type        = bool
  default     = true
}

variable "alarm_email" {
  description = "Alarm notification address."
  type        = string
  default     = null
}

variable "provider_keys" {
  description = "Optional model provider keys by slug, e.g. { openai = \"sk-...\" } (stored in Secrets Manager and in state). Prefer null and putting them in <name_prefix>/provider-keys by hand."
  type        = map(string)
  default     = null
  sensitive   = true
}

variable "search_provider" {
  description = "Web search for the web_search tool: none, searxng (with searxng_url), tavily, exa or brave."
  type        = string
  default     = "none"
}

variable "searxng_url" {
  description = "SEARXNG_URL with search_provider = \"searxng\" (a SearXNG instance the API can reach)."
  type        = string
  default     = null
}

variable "tavily_api_key" {
  description = "Optional TAVILY_API_KEY (stored in state). Prefer null and putting it in <name_prefix>/search by hand."
  type        = string
  default     = null
  sensitive   = true
}

variable "exa_api_key" {
  description = "Optional EXA_API_KEY (stored in state). Prefer null and putting it in by hand."
  type        = string
  default     = null
  sensitive   = true
}

variable "brave_api_key" {
  description = "Optional BRAVE_API_KEY (stored in state). Prefer null and putting it in by hand."
  type        = string
  default     = null
  sensitive   = true
}

variable "moderation_provider" {
  description = "MODERATION_PROVIDER: none or openai (needs an openai entry in PROVIDER_KEYS)."
  type        = string
  default     = "none"
}

variable "media_cors_extra_origins" {
  description = "Extra origins allowed to upload to the media bucket, e.g. [\"http://localhost:3540\"] for make up-aws."
  type        = list(string)
  default     = []
}

variable "api_extra_environment" {
  description = "Extra API and worker environment. Never secrets."
  type        = map(string)
  default     = {}
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.medium"
}

variable "cache_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.m7g.large"
}

variable "cpu_architecture" {
  description = "X86_64 or ARM64 (Graviton). ARM64 needs linux/arm64 images: PLATFORM=linux/arm64 make aws-deploy."
  type        = string
  default     = "X86_64"
}

variable "app_db_secret_arn" {
  description = "Secret of the least-privilege application database role (docs/guides/operations.md). Null: the api and worker use the RDS master user."
  type        = string
  default     = null
}

variable "app_db_username" {
  description = "Login of the application database role (with app_db_secret_arn)."
  type        = string
  default     = null
}

variable "log_level" {
  description = "LOG_LEVEL for the api and worker."
  type        = string
  default     = "info"
}

variable "require_email_verification" {
  description = "REQUIRE_EMAIL_VERIFICATION: new accounts confirm their email before signing in."
  type        = bool
  default     = true
}

variable "api_extra_secrets" {
  description = "Extra ECS secrets for the api and worker, e.g. [{ name = \"SMTP_PASS\", valueFrom = \"<secret arn>:SMTP_PASS::\" }]."
  type        = list(object({ name = string, valueFrom = string }))
  default     = []
}
