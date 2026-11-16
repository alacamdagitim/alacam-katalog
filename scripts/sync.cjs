const { shopifyClient } = require('../lib/shopify-admin.cjs');
const { synchronize } = require('../lib/shopify-sync.cjs');
const { snapshotRepository, createSnapshotService } = require('../lib/shopify-snapshot.cjs');

(async () => {
  const { client, catalogId } = shopifyClient();
  const service = createSnapshotService({ catalogId, repository: snapshotRepository(catalogId), synchronize: () => synchronize(client, catalogId) });
  await service.refresh();
  const saved = await service.read(true);
  if (!saved) throw new Error('Katalog başka bir işlem tarafından hazırlanıyor; daha sonra yeniden deneyin.');
  console.log(`${saved.data.catalogTitle}: ${saved.data.productCount} ürün; ${saved.data.syncedAt}`);
})().catch(error => { console.error(error.code ?? 'sync_failed'); process.exitCode = 1; });
