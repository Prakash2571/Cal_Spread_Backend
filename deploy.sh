#!/bin/bash
set -e

echo "========================================="
echo "  Calspread Full Deploy"
echo "========================================="
echo ""

echo "[1/8] Stopping PM2 processes..."
pm2 stop frontend && pm2 stop backend || true
echo ""

echo "[2/8] Pulling backend..."
cd ~/Cal_Spread_Backend
git checkout -- tsconfig.tsbuildinfo 2>/dev/null || true
git pull origin main
echo ""

echo "[3/8] Installing backend dependencies..."
npm i
echo ""

echo "[4/8] Building backend..."
npm run build
echo ""

echo "[5/8] Starting backend..."
pm2 start backend
echo ""

echo "[6/8] Pulling frontend..."
cd ~/Cal_Spread
rm -f tsconfig.tsbuildinfo package-lock.json 2>/dev/null || true
git pull origin main
echo ""

echo "[7/8] Installing & building frontend..."
npm i && npm run build
echo ""

echo "[8/8] Starting frontend & reloading nginx..."
pm2 start frontend
sudo nginx -t && sudo systemctl reload nginx
echo ""

echo "========================================="
echo "  Deploy complete!"
echo "========================================="
pm2 status
