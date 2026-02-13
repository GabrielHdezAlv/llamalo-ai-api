#!/bin/bash

# Script para migrar la fuente de conocimiento existente
# Usar: ./migrate-source.sh

SOURCE_ID="src_1770922036884_ylk71ldjz"
BASE_URL="https://llamaloiabackend-5294.onrender.com"

CONTENT="Llamalo AI es una plataforma SaaS especializada en la creación de agentes telefónicos con inteligencia artificial para empresas. Fue diseñada para automatizar llamadas entrantes y salientes, permitiendo a las compañías atender clientes 24/7 sin necesidad de ampliar su equipo humano. La plataforma está orientada principalmente a pymes y startups de sectores como inmobiliarias, clínicas privadas, concesionarios de coches y servicios técnicos.

Cada agente puede configurarse con un nombre, un tono de voz (formal, cercano o profesional) y un conjunto de instrucciones personalizadas. Además, los agentes pueden apoyarse en una base de conocimientos que admite tres tipos de fuentes: PDFs, URLs para scraping de contenido web y texto manual introducido desde el panel de administración. Esta base de conocimientos se utiliza para generar respuestas coherentes y alineadas con la información oficial de la empresa.

Llamalo AI permite integraciones mediante API REST y webhooks, facilitando la conexión con CRMs externos. La plataforma funciona bajo un modelo de suscripción mensual, con planes que varían según el número de minutos de llamada y el consumo de tokens de IA.

El sistema incluye métricas como duración media de llamadas, coste por llamada, tasa de resolución y número de llamadas gestionadas por agente. Además, todos los datos se almacenan en la nube con arquitectura escalable y enfoque en seguridad."

echo "🔄 Migrando fuente de conocimiento $SOURCE_ID..."
echo "📝 Enviando contenido al servidor..."

curl -X POST "$BASE_URL/migration/migrate-source" \
  -H "Content-Type: application/json" \
  -d "{
    \"sourceId\": \"$SOURCE_ID\",
    \"content\": $(echo "$CONTENT" | jq -Rs .)
  }"

echo -e "\n✅ Migración completada"
echo "📞 Ahora puedes hacer una llamada para probar el conocimiento del agente"
