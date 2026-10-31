import assert from 'node:assert/strict';

// Check the wire contract at the model boundary, rather than trusting a model
// fixture that accepts tool definitions a real provider would reject.
export function assertOfficeToolSchemas(tools) {
  const expected = {
    subagent: ['description', 'prompt'],
    send_message: ['agent_id', 'message'],
    interrupt_agent: ['agent_id'],
  };
  for (const [name, required] of Object.entries(expected)) {
    const tool = tools.find(item => item.function?.name === name);
    assert.ok(tool, `${name} must be available to the model`);
    assert.equal(tool.type, 'function');
    assert.equal(typeof tool.function.description, 'string');
    const parameters = tool.function.parameters;
    assert.equal(parameters.type, 'object', `${name} must have an object schema`);
    assert.ok(parameters.properties && !Array.isArray(parameters.properties));
    assert.deepEqual([...parameters.required].sort(), [...required].sort());
    for (const key of required) assert.equal(parameters.properties[key]?.type, 'string', `${name}.${key} must be a string parameter`);
    for (const [key, property] of Object.entries(parameters.properties)) {
      assert.equal(typeof property.description, 'string', `${name}.${key}.description must be a string annotation`);
      assert.equal(property.required, undefined, `${name}.${key} must use the object-level required array`);
    }
    if (name === 'subagent') {
      assert.equal(parameters.properties.avatar.type, 'string');
      assert.equal(parameters.properties.run_in_background.type, 'boolean');
      assert.deepEqual(parameters.properties.run_in_background.enum, [true]);
    }
  }
}
