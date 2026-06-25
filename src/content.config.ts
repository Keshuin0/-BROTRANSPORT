import { defineCollection, z } from 'astro:content';
import fs from 'fs';
import path from 'path';

// Custom loader to bypass glob resolving issues with '#' on Windows
const localFleetLoader = () => {
  return {
    name: 'local-fleet-loader',
    load: async ({ store, parseData }: any) => {
      const targetDir = path.resolve('src/content/fleet');
      if (!fs.existsSync(targetDir)) return;
      const files = fs.readdirSync(targetDir);
      
      for (const file of files) {
        if (!file.endsWith('.mdx') || file.startsWith('_')) continue;
        const id = file.replace(/\.mdx$/, '');
        const filePath = path.join(targetDir, file);
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        
        // Parse frontmatter (YAML block)
        const match = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
        if (match) {
          const yaml = match[1];
          const body = match[2];
          const data: any = {};
          
          const lines = yaml.split('\n');
          let currentKey = '';
          
          lines.forEach(line => {
            const trimmed = line.trim();
            if (trimmed.startsWith('-')) {
              if (currentKey) {
                if (!Array.isArray(data[currentKey])) {
                  data[currentKey] = [];
                }
                const val = trimmed.substring(1).trim().replace(/^['"]|['"]$/g, '');
                data[currentKey].push(val);
              }
            } else {
              const index = line.indexOf(':');
              if (index > -1) {
                currentKey = line.substring(0, index).trim();
                let val = line.substring(index + 1).trim();
                // Clean surrounding quotes
                val = val.replace(/^['"]|['"]$/g, '');
                
                if (val === '') {
                  data[currentKey] = [];
                } else if (val === 'true') {
                  data[currentKey] = true;
                } else if (val === 'false') {
                  data[currentKey] = false;
                } else if (!isNaN(Number(val)) && val !== '') {
                  data[currentKey] = Number(val);
                } else {
                  data[currentKey] = val;
                }
              }
            }
          });

          // Validate schema matching defineCollection
          const parsedData = await parseData({ id, data });

          store.set({
            id,
            data: parsedData,
            body: body.trim()
          });
        }
      }
    }
  };
};

const fleet = defineCollection({
  loader: localFleetLoader(),
  schema: z.object({
    title: z.string(),
    capacityTonnage: z.number(),
    axleConfiguration: z.string(),
    superloadSpec: z.boolean().default(false),
    equipmentSpecs: z.array(z.string()).optional(),
  })
});

export const collections = { fleet };
