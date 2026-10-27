variable "name_prefix" {
  description = "Prefix for every resource name."
  type        = string
}

variable "kms_key_arn" {
  description = "CMK that encrypts the secrets. Null uses the AWS-managed key."
  type        = string
  default     = null
}

variable "recovery_window_in_days" {
  description = "Days a deleted secret stays recoverable. 0 deletes immediately (local and throwaway environments)."
  type        = number
  default     = 30
}

# ─── Model providers ─────────────────────────────────────────────────────────

variable "provider_keys" {
  description = "Initial PROVIDER_KEYS: model provider API keys by slug, e.g. { openai = \"sk-...\", anthropic = \"sk-ant-...\" }. Null writes \"set-me\" for every provider_slugs entry, to replace by hand, which keeps the keys out of Terraform state."
  type        = map(string)
  default     = null
  sensitive   = true
}

variable "provider_slugs" {
  description = "Slugs written as \"set-me\" placeholders when provider_keys is null, so the JSON shape to fill in is visible in the console."
  type        = list(string)
  default     = ["openai", "anthropic", "gemini", "openrouter", "groq"]
}

# ─── Web search ──────────────────────────────────────────────────────────────

variable "create_search_secret" {
  description = "Create the <prefix>/search secret and inject TAVILY_API_KEY, EXA_API_KEY and BRAVE_API_KEY. A plain boolean so the decision is known at plan time."
  type        = bool
  default     = false
}

variable "tavily_api_key" {
  description = "Initial TAVILY_API_KEY. Null writes \"set-me\"."
  type        = string
  default     = null
  sensitive   = true
}

variable "exa_api_key" {
  description = "Initial EXA_API_KEY. Null writes \"set-me\"."
  type        = string
  default     = null
  sensitive   = true
}

variable "brave_api_key" {
  description = "Initial BRAVE_API_KEY. Null writes \"set-me\"."
  type        = string
  default     = null
  sensitive   = true
}

# ─── Push notifications ──────────────────────────────────────────────────────

variable "create_push_secret" {
  description = "Create the <prefix>/push secret and inject FCM_SERVICE_ACCOUNT_JSON. A plain boolean so the decision is known at plan time."
  type        = bool
  default     = false
}

variable "fcm_service_account_json" {
  description = "Initial FCM_SERVICE_ACCOUNT_JSON (the Firebase service account key file). Null writes \"set-me\"."
  type        = string
  default     = null
  sensitive   = true
}
