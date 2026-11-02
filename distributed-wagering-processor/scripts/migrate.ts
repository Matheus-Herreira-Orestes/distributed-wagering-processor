import { MikroORM } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config.js';

type MigrationCommand = 'up' | 'down' | 'pending';

const command = process.argv[2];

if (!isMigrationCommand(command)) {
  throw new Error('Usage: bun scripts/migrate.ts <up|down|pending>');
}

const orm = await MikroORM.init(config);

try {
  const migrator = orm.getMigrator();

  switch (command) {
    case 'up': {
      const applied = await migrator.up();
      report('Applied', applied);
      break;
    }
    case 'down': {
      const reverted = await migrator.down();
      report('Reverted', reverted);
      break;
    }
    case 'pending': {
      const pending = await migrator.getPendingMigrations();
      report('Pending', pending);
      break;
    }
  }
} finally {
  await orm.close(true);
}

function isMigrationCommand(value: string | undefined): value is MigrationCommand {
  return value === 'up' || value === 'down' || value === 'pending';
}

function report(label: string, migrations: ReadonlyArray<{ name: string }>): void {
  if (migrations.length === 0) {
    console.log(`${label}: none`);
    return;
  }

  console.log(`${label}:`);
  for (const migration of migrations) {
    console.log(`- ${migration.name}`);
  }
}
