#!/usr/bin/env node

/**
 * Script multiplataforma para ejecutar Firebase MCP con service account
 * Funciona en Mac, Windows y Linux
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Obtener el directorio del proyecto (directorio de trabajo actual donde se ejecuta el script)
// Cursor ejecuta el script desde la raíz del proyecto, así que process.cwd() es la raíz
const projectRoot = process.cwd();
const credentialsPath = path.join(projectRoot, 'src', 'config', 'firebase-service-account.json');

// Verificar que el archivo de credenciales existe
if (!fs.existsSync(credentialsPath)) {
  console.error(`❌ Error: No se encontró el archivo de credenciales en: ${credentialsPath}`);
  process.exit(1);
}

// Resolver la ruta absoluta (importante para Windows)
const absoluteCredentialsPath = path.resolve(credentialsPath);

console.log(`🔑 Usando credenciales: ${absoluteCredentialsPath}`);

// Establecer la variable de entorno
process.env.GOOGLE_APPLICATION_CREDENTIALS = absoluteCredentialsPath;

// Ejecutar Firebase MCP
const args = [
  '-y',
  'firebase-tools@latest',
  'experimental:mcp',
  '--only',
  'firestore,auth,functions,billing'
];

const firebaseProcess = spawn('npx', args, {
  stdio: 'inherit',
  env: process.env,
  shell: true // Necesario para Windows
});

firebaseProcess.on('error', (error) => {
  console.error(`❌ Error al ejecutar Firebase MCP:`, error);
  process.exit(1);
});

firebaseProcess.on('exit', (code) => {
  process.exit(code || 0);
});
