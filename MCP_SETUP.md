# Configuración de MCP (Model Context Protocol) para Cursor

Este proyecto utiliza MCP para conectar Cursor con Firebase, permitiendo que el asistente de IA acceda a datos de Firestore, Auth, Functions y Billing.

## 📋 Requisitos Previos

1. **Cursor IDE** instalado
2. **Node.js** y **npm** instalados
3. **Firebase CLI** autenticado (opcional, dependiendo de la configuración)

## 🚀 Configuración Inicial

### Paso 1: Clonar el Repositorio

```bash
git clone <repository-url>
cd llamalo-ai-api
```

### Paso 2: Configurar el Symlink de MCP

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

### Paso 3: Verificar la Configuración

1. Abre Cursor IDE
2. Ve a **Settings** > **Features** > **MCP Servers**
3. Deberías ver el servidor "firebase" configurado correctamente
4. Si hay errores, verifica que el symlink esté creado correctamente

## 📁 Estructura de Archivos

```
llamalo-ai-api/
├── mcp.json                    ← Archivo de configuración MCP (versionado en Git)
└── .cursor/
    └── mcp.json -> ../mcp.json ← Symlink (Cursor lee desde aquí)
```

## ⚙️ Configuración Actual

El archivo `mcp.json` está configurado para:

- **Proyecto Firebase:** `llamaloio`
- **Servicios incluidos:** Firestore, Auth, Functions, Billing
- **Documentación:** Habilitada

## 🔧 Solución de Problemas

### Error: "Server 'firebase' must have either a command or url"

Este error indica que el formato del `mcp.json` no es correcto. Verifica que el archivo tenga la estructura adecuada según el tipo de servidor MCP que estés usando.

### El symlink no funciona en Windows

Si estás en Windows y el symlink no funciona:
1. Usa PowerShell como Administrador para crear el symlink
2. O simplemente copia el archivo: `cp mcp.json .cursor/mcp.json`

### Cursor no detecta el servidor MCP

1. Verifica que el archivo `.cursor/mcp.json` existe
2. Reinicia Cursor IDE
3. Verifica que el symlink apunta correctamente: `ls -la .cursor/mcp.json` (macOS/Linux)

## 📝 Notas Importantes

- El archivo `mcp.json` está versionado en Git para que todos los desarrolladores lo tengan
- El symlink `.cursor/mcp.json` debe crearse localmente (no se versiona el symlink en sí)
- Si modificas `mcp.json`, los cambios se reflejarán automáticamente a través del symlink

## 🔗 Recursos Adicionales

- [Documentación de MCP en Cursor](https://cursor.sh/docs/mcp)
- [Firebase MCP Server](https://firebase.google.com/docs/ai-assistance/mcp-server)
