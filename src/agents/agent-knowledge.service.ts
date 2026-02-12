import { Injectable, Logger } from '@nestjs/common';
import { KnowledgeBaseService } from '../knowledge-base/knowledge-base.service';

@Injectable()
export class AgentKnowledgeService {
  private readonly logger = new Logger(AgentKnowledgeService.name);

  constructor(private readonly knowledgeBaseService: KnowledgeBaseService) {}

  async searchAgentKnowledge(agentId: number, query: string): Promise<string> {
    try {
      console.log(
        `🔍 [AgentKnowledge] Buscando conocimiento para agente ${agentId} con query: "${query}"`,
      );

      // Get knowledge sources linked to this agent
      const agentSources =
        await this.knowledgeBaseService.getAgentKnowledgeSources(agentId);

      if (agentSources.length === 0) {
        console.log(
          `🔍 [AgentKnowledge] Agente ${agentId} no tiene fuentes de conocimiento vinculadas`,
        );
        return '';
      }

      const sourceIds = agentSources.map((source) => source.id);
      console.log(
        `🔍 [AgentKnowledge] Encontradas ${sourceIds.length} fuentes para agente ${agentId}:`,
        sourceIds,
      );

      // Search in knowledge base
      console.log(`🔍 [AgentKnowledge] Ejecutando búsqueda con sourceIds:`, {
        sourceIdsCount: sourceIds.length,
        sourceIds,
        query,
      });

      const searchResults = await this.knowledgeBaseService.searchKnowledge({
        query,
        sourceIds,
        limit: 5,
      });

      console.log(`🔍 [AgentKnowledge] Resultados de búsqueda:`, {
        totalResults: searchResults.results.length,
        results: searchResults.results.map((r) => ({
          sourceName: r.sourceName,
          contentPreview:
            r.content.substring(0, 100) + (r.content.length > 100 ? '...' : ''),
          score: r.score || 'N/A',
        })),
      });

      // Format results as context for the agent
      if (searchResults.results.length === 0) {
        console.log(
          `🔍 [AgentKnowledge] No se encontraron resultados en las fuentes para agente ${agentId}`,
        );
        return '';
      }

      const context = searchResults.results
        .map((result) => `Fuente: ${result.sourceName}\n${result.content}`)
        .join('\n\n---\n\n');

      console.log(
        `✅ [AgentKnowledge] Contexto generado para agente ${agentId} (${context.length} chars)`,
      );
      console.log(
        `📝 [AgentKnowledge] Vista previa del contexto:`,
        context.substring(0, 200) + (context.length > 200 ? '...' : ''),
      );
      return context;
    } catch (error) {
      console.error(
        `❌ [AgentKnowledge] Error searching agent knowledge: ${error.message}`,
      );
      return '';
    }
  }

  async createAgentWithKnowledge(
    userId: string,
    agentData: any,
    knowledgeData: any,
  ): Promise<any> {
    try {
      // Create agent first (this would be handled by the existing agent service)
      const agent = await this.createAgent(userId, agentData);

      // Process new knowledge sources if any
      if (knowledgeData.newSources && knowledgeData.newSources.length > 0) {
        for (const sourceData of knowledgeData.newSources) {
          await this.knowledgeBaseService.createKnowledgeSource(
            userId,
            sourceData,
          );
        }
      }

      // Link existing sources to agent
      if (
        knowledgeData.existingSourceIds &&
        knowledgeData.existingSourceIds.length > 0
      ) {
        await this.knowledgeBaseService.linkSourcesToAgent(
          agent.agentId,
          userId,
          { sourceIds: knowledgeData.existingSourceIds },
        );
      }

      return agent;
    } catch (error) {
      this.logger.error(
        `Error creating agent with knowledge: ${error.message}`,
      );
      throw error;
    }
  }

  // This would be implemented by calling the existing AgentsService
  private createAgent(userId: string, agentData: any): Promise<any> {
    // Placeholder - this would integrate with the existing createAgent method
    return Promise.resolve({
      agentId: Date.now(),
      ...agentData,
    });
  }
}
