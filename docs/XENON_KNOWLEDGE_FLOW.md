# Flujo de Conocimiento e Inyección de Prompts (Agente Xenon)

Este documento explica cómo el backend construye la "memoria" y las "reglas" del agente de voz antes de cada respuesta. El objetivo es mantener el código limpio, separando la lógica de negocio (`streams.gateway.ts`) de los textos legales, reglas de comportamiento y directrices de la empresa.

---

## 🧱 1. Anatomía del Prompt (Cómo se construye)

Cuando el usuario termina de hablar, el sistema no envía solo la pregunta a OpenAI. Construye un "System Prompt" maestro ensamblando piezas como si fueran bloques de Lego en el método `enrichInstructionsWithShopify()`.

El orden de inyección es estrictamente este:

1. **Instrucciones Base:** Lo que el cliente configuró en el panel de control (ej. *"Eres María, asistente de zapatería..."*).
2. **Reglas de Voz (Voice UI):** Instrucciones técnicas para evitar el "robocismo" (evitar markdown, usar frases cortas).
3. **Conocimiento Estático de la Empresa (Xenon):** Políticas de privacidad y términos leídos desde archivos de texto.
4. **Contexto Dinámico (Shopify):** El JSON en tiempo real con datos de pedidos y stock.

---

## 📁 2. Origen de los Datos (Estructura de Ficheros)

Para editar la personalidad, reglas o conocimiento legal del agente, **NO debes editar el código TypeScript**. Todos los textos residen en directorios estáticos:

### A. Directorio: `src/prompts/`
Contiene las plantillas y reglas obligatorias para todos los agentes telefónicos.

* **`voice-rules.md`**: Reglas estrictas de Voice UI. Aquí le prohibimos a la IA usar listas con viñetas, le obligamos a usar pausas naturales (comas), leer los números pausadamente y limitar sus frases a 15 palabras.
* **`shopify-context.md`**: Es una plantilla (Template). Le enseña al LLM cómo debe leer el JSON de Shopify que le pasamos. Contiene reglas del tipo *"Para preguntas sobre PEDIDOS → Busca el campo 'pedidosRecientes'"*.

### B. Directorio: `src/knowledge/xenon/`
Contiene la base de conocimiento estática corporativa. Esta carpeta es ideal para inyectar PDFs o documentos transformados a `.txt` para que el agente sepa responder sobre legalidad, devoluciones o soporte.

* **`privacy_policy.txt`**: Versión optimizada (en bullet points y lenguaje natural) de la política de privacidad de Llamalo AI. El agente la lee para responder a dudas como: *"¿Estás grabando esta llamada?"* o *"¿Qué hacéis con mis datos?"*.
* **`terms_and_conditions.txt`**: Versión optimizada de los términos de servicio. El agente la usa como escudo protector. Si un usuario intenta hacer algo prohibido (como usar el agente para hacer fraude o pedir que mienta sobre su identidad de IA), el agente sabe negarse consultando este archivo.

---

## ⚙️ 3. ¿Cómo lee el sistema estos ficheros?

En `src/streams/streams.gateway.ts`, existe un helper llamado `readStaticFile(filePath)`.

Durante el ciclo de la llamada:
1. El sistema busca las rutas relativas (ej. `src/knowledge/xenon/privacy_policy.txt`).
2. Usa el módulo `fs` (File System) de Node.js para extraer el texto.
3. Si el archivo existe y tiene contenido, se inyecta en el Prompt con una cabecera:
   ```text
   ============================================================
   ## 🏢 CONOCIMIENTO DE LA EMPRESA 🏢
   ============================================================
   ### Políticas de Privacidad:
   [Contenido de privacy_policy.txt]
   ```
4. Si el archivo es borrado o está vacío, el sistema no falla; simplemente omite ese bloque de conocimiento.

---

## 📝 4. ¿Cómo actualizar el conocimiento de Xenon?

Para modificar lo que el agente sabe sobre la empresa, **no necesitas hacer deploy de código** si tu servidor soporta recarga de archivos estáticos (o en desarrollo local).

1. Abre el archivo correspondiente en `src/knowledge/xenon/`.
2. Edita el texto. **Recomendación:** Usa viñetas (`-`) e instrucciones claras en lugar de párrafos legales de 10 líneas, ya que el LLM los procesa mucho más rápido.
3. Guarda el archivo.
4. En la próxima llamada, el método `readStaticFile` leerá la versión nueva y la inyectará en el cerebro de OpenAI.