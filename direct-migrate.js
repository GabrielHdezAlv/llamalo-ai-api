// Script de migración directa usando Firebase Admin SDK
const admin = require('firebase-admin');
const fetch = require('node-fetch');

// Configuración - necesitarás actualizar esto
const serviceAccount = {
  "projectId": "llamalo-ai",
  // Agrega aquí tus credenciales de Firebase o usa variables de entorno
};

// Inicializar Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function generateEmbedding(text) {
  // Usar OpenAI API para generar embeddings
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: text,
      model: 'text-embedding-3-small',
    }),
  });

  const data = await response.json();
  return data.data[0].embedding;
}

async function migrateSource() {
  const sourceId = 'src_1770922036884_ylk71ldjz';
  
  const content = `Llamalo AI es una plataforma SaaS especializada en la creación de agentes telefónicos con inteligencia artificial para empresas. Fue diseñada para automatizar llamadas entrantes y salientes, permitiendo a las compañías atender clientes 24/7 sin necesidad de ampliar su equipo humano. La plataforma está orientada principalmente a pymes y startups de sectores como inmobiliarias, clínicas privadas, concesionarios de coches y servicios técnicos.

Cada agente puede configurarse con un nombre, un tono de voz (formal, cercano o profesional) y un conjunto de instrucciones personalizadas. Además, los agentes pueden apoyarse en una base de conocimientos que admite tres tipos de fuentes: PDFs, URLs para scraping de contenido web y texto manual introducido desde el panel de administración. Esta base de conocimientos se utiliza para generar respuestas coherentes y alineadas con la información oficial de la empresa.

Llamalo AI permite integraciones mediante API REST y webhooks, facilitando la conexión con CRMs externos. La plataforma funciona bajo un modelo de suscripción mensual, con planes que varían según el número de minutos de llamada y el consumo de tokens de IA.

El sistema incluye métricas como duración media de llamadas, coste por llamada, tasa de resolución y número de llamadas gestionadas por agente. Además, todos los datos se almacenan en la nube con arquitectura escalable y enfoque en seguridad.`;

  console.log('🔄 Iniciando migración directa...');

  try {
    // Crear chunks
    const chunkSize = 1000;
    const overlap = 200;
    const chunks = [];
    
    for (let i = 0; i < content.length; i += chunkSize - overlap) {
      const chunkContent = content.substring(i, i + chunkSize);
      const chunkId = `chunk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      chunks.push({
        id: chunkId,
        content: chunkContent,
        metadata: {
          sourceId: sourceId,
          chunkIndex: Math.floor(i / (chunkSize - overlap)),
          totalChunks: Math.ceil(content.length / (chunkSize - overlap))
        }
      });
    }

    console.log(`📝 Creados ${chunks.length} chunks`);

    // Generar embeddings para cada chunk
    const batch = db.batch();
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      
      console.log(`🔢 Generando embedding ${i + 1}/${chunks.length}`);
      
      const embedding = await generateEmbedding(chunk.content);
      
      const chunkRef = db.collection('vectorChunks').doc(`${sourceId}_${chunk.id}`);
      
      const chunkData = {
        sourceId: sourceId,
        chunkId: chunk.id,
        content: chunk.content,
        embedding: embedding,
        metadata: chunk.metadata,
        createdAt: new Date(),
      };
      
      batch.set(chunkRef, chunkData);
    }

    await batch.commit();
    
    console.log('✅ Migración completada exitosamente');
    console.log('📞 El agente ahora debería tener conocimiento sobre Llamalo AI');
    
  } catch (error) {
    console.error('❌ Error en migración:', error);
  } finally {
    process.exit(0);
  }
}

migrateSource();
