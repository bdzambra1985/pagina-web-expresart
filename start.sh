#!/bin/bash
cd "$(dirname "$0")"
echo ""
echo "  Iniciando EXPRESART en modo local..."
echo "  URL local: http://localhost:9090"
echo "  Admin:     usuario 'admin' — contraseña definida en EXP_ADMIN_PW"
echo ""
npm start
