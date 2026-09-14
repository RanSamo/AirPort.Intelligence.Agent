import { CreateScoringContainer } from '../Container/CreateScoringContainer';
import { CreateToolRegistry } from '../Agent/Tools/ToolRegistry';
import { ToolContext } from '../Agent/Tools/ToolContext';

/**
 * Prints the tool definitions exactly as the model receives them.
 *
 * Tool selection is driven entirely by the name, description and input schema
 * sent with each request - there is no hidden routing layer. Being able to
 * read what the model reads is the fastest way to debug a tool it keeps
 * choosing wrongly, or failing to choose at all.
 *
 *   npm run tools:preview
 *   npm run tools:preview -- --full
 */

interface ToolShape {
  name: string;
  description: string;
  inputSchema?: unknown;
  input_schema?: unknown;
}

function Main() {
  const showFull = process.argv.includes('--full');

  const container = CreateScoringContainer({ logLevel: 'error' });
  const tools = CreateToolRegistry(new ToolContext(container)) as unknown as ToolShape[];

  process.stdout.write(`${tools.length} tools sent to the model\n\n`);

  for (const tool of tools) {
    process.stdout.write(`=== ${tool.name} ===\n`);
    process.stdout.write(`${tool.description}\n\n`);

    const schema = (tool.input_schema ?? tool.inputSchema) as SchemaShape | undefined;
    const properties = schema?.properties ?? {};

    for (const [field, definition] of Object.entries(properties)) {
      const enumValues = definition.enum ? ` (${definition.enum.join(' | ')})` : '';
      const required = schema?.required?.includes(field) ? ' [required]' : '';
      process.stdout.write(`  ${field}: ${definition.type ?? 'any'}${enumValues}${required}\n`);
      if (definition.description) process.stdout.write(`      ${definition.description}\n`);
    }

    if (showFull) process.stdout.write(`\n${JSON.stringify(schema, null, 2)}\n`);
    process.stdout.write('\n');
  }

  container.database.Close();
}

interface SchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
}

interface SchemaShape {
  properties?: { [field: string]: SchemaProperty };
  required?: string[];
}

Main();
