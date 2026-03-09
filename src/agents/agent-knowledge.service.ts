import { Injectable, Logger } from '@nestjs/common';
import { KnowledgeBaseService } from '../knowledge-base/knowledge-base.service';

@Injectable()
export class AgentKnowledgeService {
  private readonly logger = new Logger(AgentKnowledgeService.name);

  constructor(private readonly knowledgeBaseService: KnowledgeBaseService) {}

  async searchAgentKnowledge(
    agentId: number,
    query: string,
    preloadedSourceIds?: string[],
  ): Promise<string> {
    try {
      const sourceIds = preloadedSourceIds
        ? preloadedSourceIds
        : (await this.knowledgeBaseService.getAgentKnowledgeSources(agentId)).map(
            (source) => source.id,
          );

      if (sourceIds.length === 0) {
        return '';
      }
      const searchResults = await this.knowledgeBaseService.searchKnowledge({
        query,
        sourceIds,
        limit: 5,
      });

      if (searchResults.results.length === 0) {
        return '';
      }

      const context = searchResults.results
        .map((result) => `Fuente: ${result.sourceName}\n${result.content}`)
        .join('\n\n---\n\n');

      return context;
    } catch (error) {
      console.error(
        `❌ [AgentKnowledge] Error searching agent knowledge: ${error.message}`,
      );
      return '';
    }
  }

  async getAgentKnowledgeSources(agentId: number): Promise<any[]> {
    return this.knowledgeBaseService.getAgentKnowledgeSources(agentId);
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
