# Configuración de MCP (Model Context Protocol) para Cursor

Este proyecto utiliza MCP para conectar Cursor con Firebase, permitiendo que el asistente de IA acceda a datos de Firestore, Auth, Functions y Billing.

## 📋 Requisitos Previos

1. **Cursor IDE** instalado
2. **Node.js** y **npm** instalados
3. **Archivo de credenciales de Firebase Service Account** en `src/config/firebase-service-account.json`

## 🚀 Configuración Inicial

### Paso 1: Clonar el Repositorio

```bash
git clone <repository-url>
cd llamalo-ai-api
```

### Paso 2: Configurar las Credenciales de Firebase

**IMPORTANTE:** Necesitas tener el archivo de credenciales de Firebase Service Account:

1. Obtén el archivo JSON de credenciales desde Firebase Console:
   - Ve a **Project Settings** > **Service Accounts**
   - Haz clic en **Generate new private key**
   - Guarda el archivo como `firebase-service-account.json`

2. Coloca el archivo en `src/config/firebase-service-account.json`

   ⚠️ **Nota de Seguridad:** Este archivo contiene credenciales sensibles y está en `.gitignore`. Cada desarrollador debe tener su propia copia.

### Paso 3: Configurar el Symlink de MCP

El proyecto tiene un archivo `mcp.json` en la raíz que debe estar disponible en `.cursor/mcp.json` para que Cursor lo detecte.

#### En macOS/Linux:

```bash
# Crear el symlink automáticamente
ln -s ../mcp.json .cursor/mcp.json
```

#### En Windows:

**Opción A - Usando PowerShell (como Administrador):**
```powershell
# Crear symlink
New-Item -ItemType SymbolicLink -Path ".cursor\mcp.json" -Target "..\mcp.json"
```

**Opción B - Copiar el archivo:**
```bash
# Si el symlink no funciona, simplemente copia el archivo
cp mcp.json .cursor/mcp.json
```

### Paso 4: Verificar la Configuración

1. Abre Cursor IDE
2. Ve a **Settings** > **Features** > **MCP Servers**
3. Deberías ver el servidor "firebase" configurado correctamente
4. Si hay errores, verifica que el symlink esté creado correctamente

## 📁 Estructura de Archivos

```
llamalo-ai-api/
├── mcp.json                    ← Archivo de configuración MCP (versionado en Git)
├── scripts/
│   └── run-firebase-mcp.js     ← Script multiplataforma para ejecutar MCP (versionado)
├── src/
│   └── config/
│       └── firebase-service-account.json ← Credenciales (NO versionado, en .gitignore)
└── .cursor/
    └── mcp.json -> ../mcp.json ← Symlink (Cursor lee desde aquí)
```

## ⚙️ Configuración Actual

El archivo `mcp.json` está configurado para usar un script multiplataforma que:

- **Usa Service Account:** Se autentica automáticamente usando `src/config/firebase-service-account.json`
- **Multiplataforma:** Funciona en Mac, Windows y Linux
- **Proyecto Firebase:** `llamaloio` (definido en el service account)
- **Servicios incluidos:** Firestore, Auth, Functions, Billing

### Cómo Funciona

El script `scripts/run-firebase-mcp.js`:
1. Verifica que el archivo de credenciales exista
2. Establece la variable de entorno `GOOGLE_APPLICATION_CREDENTIALS`
3. Ejecuta Firebase MCP con los servicios configurados

**Ventajas:**
- ✅ No requiere autenticación manual con `firebase login`
- ✅ Funciona automáticamente en cualquier sistema operativo
- ✅ Usa rutas relativas (no necesita configuración por desarrollador)

## 🔧 Solución de Problemas

### Error: "No se encontró el archivo de credenciales"

**Solución:** Asegúrate de que el archivo `src/config/firebase-service-account.json` existe y contiene las credenciales válidas de Firebase Service Account.

### Error: "Server 'firebase' must have either a command or url"

Este error indica que el formato del `mcp.json` no es correcto. Verifica que el archivo tenga la estructura adecuada:

```json
{
  "mcpServers": {
    "firebase": {
      "command": "node",
      "args": ["scripts/run-firebase-mcp.js"]
    }
  }
}
```

### Error: "Permission denied" al ejecutar el script

**En Mac/Linux:**
```bash
chmod +x scripts/run-firebase-mcp.js
```

**En Windows:** No es necesario, Node.js ejecutará el script directamente.

### El symlink no funciona en Windows

Si estás en Windows y el symlink no funciona:
1. Usa PowerShell como Administrador para crear el symlink
2. O simplemente copia el archivo: `cp mcp.json .cursor/mcp.json`

### Cursor no detecta el servidor MCP

1. Verifica que el archivo `.cursor/mcp.json` existe
2. Reinicia Cursor IDE
3. Verifica que el symlink apunta correctamente: `ls -la .cursor/mcp.json` (macOS/Linux)

## 📝 Notas Importantes

- El archivo `mcp.json` y el script `scripts/run-firebase-mcp.js` están versionados en Git
- El archivo `src/config/firebase-service-account.json` **NO** está versionado (está en `.gitignore`)
- Cada desarrollador debe tener su propia copia del archivo de credenciales
- El symlink `.cursor/mcp.json` debe crearse localmente (no se versiona el symlink en sí)
- Si modificas `mcp.json`, los cambios se reflejarán automáticamente a través del symlink
- **No necesitas ejecutar `firebase login`** - el script usa el service account directamente

## 🔗 Recursos Adicionales

- [Documentación de MCP en Cursor](https://cursor.sh/docs/mcp)
- [Firebase MCP Server](https://firebase.google.com/docs/ai-assistance/mcp-server)
