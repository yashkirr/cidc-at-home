# Examples

Copy one to the root of your repo as `pipeline.json` and change the commands to match your project.

| File | For |
|---|---|
| [node-app.json](node-app.json) | A Node project: install, lint, types, tests, build, then your own deploy script. |
| [static-site-s3.json](static-site-s3.json) | A static site on S3 and CloudFront, with a smoke test after the upload. |
| [vps-rsync.json](vps-rsync.json) | Build here, copy to a server with rsync, restart the service over SSH. |
| [vps-docker-compose.json](vps-docker-compose.json) | The app runs on the same server as the pipeline, with Docker Compose. |
| [terraform.json](terraform.json) | Infrastructure: plan in the build, apply that exact saved plan on deploy. |

Bucket names, IDs and addresses in these files are placeholders (`203.0.113.10` is a documentation-only address).
None of them are secrets, but keep real secrets out of `pipeline.json`: see [docs/security.md](../docs/security.md).
