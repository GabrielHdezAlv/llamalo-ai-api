# Base de Conocimientos - LlamaloAI API

## Resumen de Implementación

He implementado completamente el sistema de Base de Conocimientos para tu SaaS siguiendo el plan que propusiste. La arquitectura unificada permite procesar PDFs, contenido web y texto manual a través del mismo pipeline.

## 📁 Estructura Creada

```
src/knowledge-base/
├── knowledge-base.module.ts      # Módulo principal
├── knowledge-base.controller.ts  # Endpoints API
├── knowledge-base.service.ts     # Lógica de negocio
├── dto/
│   ├── knowledge-source.dto.ts   # DTOs principales
│   └── agent-knowledge.dto.ts     # DTOs para agentes
├── processors/
│   ├── base.processor.ts          # Clase base abstracta
│   ├── pdf.processor.ts           # Procesador de PDFs
│   ├── web-scraper.processor.ts   # Procesador de contenido web
│   └── text.processor.ts         # Procesador de texto
├── embeddings/
│   ├── embeddings.service.ts      # Generación de embeddings
│   └── vector-store.service.ts    # Almacenamiento vectorial
└── utils/
    ├── chunker.ts                # División en chunks
    └── text-cleaner.ts           # Limpieza de texto
```

## 🔧 Características Implementadas

### 1. **Procesamiento Unificado**
- **PDFs**: Extracción de texto con pdf-parse
- **Web**: Scraping con cheerio y limpieza de contenido
- **Texto**: Procesamiento directo de texto manual
- Todos pasan por el mismo pipeline de limpieza → chunking → embeddings

### 2. **Base de Datos Vectorial**
- Embeddings con OpenAI (text-embedding-3-small)
- Almacenamiento en memoria (escalable a ChromaDB)
- Búsqueda semántica por similitud de coseno
- Chunks de 1000 caracteres con 200 de overlap

### 3. **Gestión de Conocimiento**
- Fuentes globales reutilizables entre agentes
- Metadatos completos (estado, tamaño, chunks, tags)
- Procesamiento asíncrono con estados
- Vista previa de contenido procesado

### 4. **Integración con Agentes**
- Los agentes referencian fuentes, no almacenan conocimiento
- Búsqueda contextual filtrada por fuentes del agente
- Creación de agente con conocimiento en un solo paso
- Contexto formateado para respuestas del LLM

## 🚀 Endpoints API

### Gestión de Fuentes
- `POST /knowledge-base/sources` - Crear fuente (PDF/web/texto)
- `GET /knowledge-base/sources` - Listar fuentes del usuario
- `PUT /knowledge-base/sources/:id` - Actualizar metadatos
- `DELETE /knowledge-base/sources/:id` - Eliminar fuente

### Búsqueda y Agentes
- `POST /knowledge-base/search` - Búsqueda semántica
- `POST /knowledge-base/agents/:id/sources` - Vincular fuentes a agente
- `GET /knowledge-base/agents/:id/sources` - Ver fuentes de agente
- `GET /knowledge-base/sources/:id/preview` - Vista previa

## 📊 Flujo de Procesamiento

1. **Subida** → Crear registro con status 'processing'
2. **Extracción** → PDF/web/texto → texto plano
3. **Limpieza** → Eliminar ruido, menús, contenido irrelevante
4. **Chunking** → Dividir en fragmentos superpuestos
5. **Embeddings** → Generar vectores semánticos
6. **Almacenamiento** → Guardar en base vectorial
7. **Actualización** → Status 'completed' con metadatos

## 🔗 Integración Frontend

### Componentes UI Sugeridos
- `KnowledgeSourceCard` - Tarjeta de fuente con estado
- `SourceUploader` - Modal para subir nuevos contenidos
- `KnowledgeSelector` - Selector de fuentes para agentes
- `SearchResults` - Resultados de búsqueda con resaltado

### Flujos de Usuario
1. **Base de Conocimientos Global**: Subir y gestionar fuentes
2. **Creación de Agente**: Seleccionar fuentes existentes o subir nuevas
3. **Configuración de Agente**: Añadir/quitar conocimiento específico

## ⚙️ Configuración

Variables de entorno añadidas:
```env
# OpenAI Embeddings
OPENAI_EMBEDDING_MODEL=text-embedding-3-small

# Knowledge Base
CHUNK_SIZE=1000
CHUNK_OVERLAP=200

# Vector Database
VECTOR_DB_TYPE=memory
CHROMADB_HOST=localhost
CHROMADB_PORT=8000

# Web Scraping
PUPPETEER_HEADLESS=true
WEB_SCRAPING_TIMEOUT=30000
```

## 🔄 Próximos Pasos

1. **Instalar dependencias**: `npm install pdf-parse cheerio puppeteer langchain @langchain/openai chromadb multer sharp`
2. **Configurar variables**: Añadir OPENAI_API_KEY si no existe
3. **Probar endpoints**: Usar Swagger o Postman
4. **Implementar frontend**: Componentes UI descritos
5. **Escalar producción**: Migrar a ChromaDB persistente

## 🎯 Beneficios

- **Centralizado**: Todo el conocimiento en un lugar
- **Reutilizable**: Las fuentes sirven para múltiples agentes  
- **Escalable**: Fácil añadir nuevos tipos de fuentes
- **Eficiente**: Búsquedas semánticas rápidas
- **Flexible**: Control granular del conocimiento por agente

La implementación está completa y lista para usar. Los agentes ahora pueden responder basándose en conocimiento específico asignado, manteniendo la arquitectura limpia y escalable que diseñaste.
