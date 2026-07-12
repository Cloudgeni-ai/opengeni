variable "TAG" {
  default = "ci"
}

variable "SOURCE_SHA" {
  default = "dev"
}

group "workload-images" {
  targets = ["api", "worker", "web"]
}

group "release-images" {
  targets = ["api", "worker", "web", "relay"]
}

target "common" {
  context    = "."
  dockerfile = "docker/opengeni.Dockerfile"
  platforms  = ["linux/amd64"]
  args = {
    OPENGENI_SERVER_VERSION = SOURCE_SHA
  }
}

target "api" {
  inherits = ["common"]
  target   = "api"
  tags     = ["opengeni-api:${TAG}"]
}

target "worker" {
  inherits = ["common"]
  target   = "worker"
  tags     = ["opengeni-worker:${TAG}"]
}

target "web" {
  inherits = ["common"]
  target   = "web"
  tags     = ["opengeni-web:${TAG}"]
  args = {
    OPENGENI_SERVER_VERSION      = SOURCE_SHA
    OPENGENI_DEPLOYMENT_REVISION = SOURCE_SHA
  }
}

target "relay" {
  context    = "agent"
  dockerfile = "crates/opengeni-relay/Dockerfile"
  platforms  = ["linux/amd64"]
  tags       = ["opengeni-relay:${TAG}"]
}