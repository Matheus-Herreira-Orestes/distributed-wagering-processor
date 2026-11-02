import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { Migration20261031000000_initial_schema } from './migrations/Migration20261031000000_initial_schema.js';
import { Migration20261101000000_outbox_claiming } from './migrations/Migration20261101000000_outbox_claiming.js';

export default defineConfig({
  clientUrl: process.env.DATABASE_URL
    ?? 'postgresql://jungle:jungle@127.0.0.1:5433/jungle_wagering',
  entities: [],
  discovery: {
    warnWhenNoEntities: false,
  },
  extensions: [Migrator],
  migrations: {
    migrationsList: [
      Migration20261031000000_initial_schema,
      Migration20261101000000_outbox_claiming,
    ],
    transactional: true,
    allOrNothing: true,
  },
});
