import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

export default defineConfig({
  clientUrl: process.env.DATABASE_URL ?? 'postgresql://jungle:jungle@localhost:5432/jungle_wagering',
  entities: [],
  extensions: [Migrator],
  migrations: {
    path: 'migrations',
    pathTs: 'migrations',
    transactional: true,
    allOrNothing: true,
  },
});
