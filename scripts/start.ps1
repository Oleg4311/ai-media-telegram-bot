$ErrorActionPreference = "Stop"
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env. Fill TELEGRAM_BOT_TOKEN and ADMIN_TELEGRAM_IDS, then run this script again." -ForegroundColor Yellow
  exit 1
}
docker compose up -d --build
docker compose ps
Write-Host "Bot started. Logs: docker compose logs -f app" -ForegroundColor Green
