terraform {
  required_version = ">= 1.5"
}

resource "null_resource" "fixture" {
  triggers = {
    note = "fixture infra resource, never applied"
  }
}
