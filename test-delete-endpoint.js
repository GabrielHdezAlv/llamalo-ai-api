// Test examples for the new DELETE endpoint

const deleteEndpoint = {
  method: 'DELETE',
  url: 'https://llamaloiabackend-5294.onrender.com/knowledge-base/agents/1770666889402/sources/src_1234567890_abc123',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_TOKEN_HERE'
  }
};

console.log('DELETE Endpoint:');
console.log(JSON.stringify(deleteEndpoint, null, 2));

console.log('\nComplete API endpoints for agent knowledge sources:');
console.log('POST   /knowledge-base/agents/{agentId}/sources     - Link sources to agent');
console.log('GET    /knowledge-base/agents/{agentId}/sources     - Get agent sources');
console.log('DELETE /knowledge-base/agents/{agentId}/sources/{sourceId} - Unlink specific source');

console.log('\nExpected behavior:');
console.log('- Returns 200 if link was successfully deleted');
console.log('- Returns 404 if link does not exist');
console.log('- Returns 400 if user does not have permission');
