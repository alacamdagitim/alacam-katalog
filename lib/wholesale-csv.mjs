const MAX_QUANTITY = 2_147_483_647;

function normalize(value) {
  return value.trim().normalize('NFC');
}

export function wholesaleHandle(handle) {
  return normalize(handle);
}

export function wholesaleOptionKey(options) {
  return JSON.stringify(options.map(([name, value]) => [normalize(name), normalize(value)]));
}

function* readCsv(text) {
  let row = [];
  let field = '';
  let quoted = false;
  let closed = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
        closed = true;
      }
      continue;
    }

    if (character === ',' || character === '\n' || character === '\r') {
      row.push(field);
      field = '';
      closed = false;
      if (character !== ',') {
        if (character === '\r' && text[index + 1] === '\n') index += 1;
        yield row;
        row = [];
      }
    } else if (closed || (character === '"' && field.length)) {
      throw new Error('CSV dosyasında hatalı tırnak kullanımı var.');
    } else if (character === '"') {
      quoted = true;
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error('CSV dosyasında kapanmamış bir tırnak var.');
  if (row.length || field.length || closed) yield [...row, field];
}

function publication(value, invalid) {
  if (!value) return null;
  const state = value.toLowerCase();
  if (state === 'true') return true;
  if (state === 'false') return false;
  throw invalid('yayın durumu');
}

function money(value, field, invalid) {
  if (!value) return undefined;
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(value);
  if (!match) throw invalid(field);
  const cents = Number(match[1] + (match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || Math.round(cents / 100 * 100) !== cents) throw invalid(field);
  return cents / 100;
}

function quantity(value, field, invalid) {
  if (!value) return undefined;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(number) || number < 1 || number > MAX_QUANTITY) throw invalid(field);
  return number;
}

function orderRules(read, invalid) {
  const increment = quantity(read('Quantity Increment'), 'sipariş artışı', invalid);
  const minimum = quantity(read('Minimum Order Quantity'), 'en az sipariş miktarı', invalid);
  const maximum = quantity(read('Maximum Order Quantity'), 'en çok sipariş miktarı', invalid);

  if (minimum != null || increment != null || maximum != null) {
    if (minimum == null || increment == null || minimum % increment !== 0) throw invalid('sipariş miktarı kuralı');
    if (maximum != null && (maximum < minimum || maximum % increment !== 0)) throw invalid('en çok sipariş miktarı');
  }

  const tiers = [];
  const thresholds = new Set();
  for (let index = 1; index <= 10; index += 1) {
    const units = quantity(read(`Quantity Break ${index}`), `${index}. fiyat kademesi miktarı`, invalid);
    const price = money(read(`Price Break ${index}`), `${index}. fiyat kademesi tutarı`, invalid);
    if (units == null && price == null) continue;
    if (units == null || price == null || units < (minimum ?? 1) || units > (maximum ?? MAX_QUANTITY)
      || units % (increment ?? 1) !== 0 || thresholds.has(units)) throw invalid(`${index}. fiyat kademesi`);
    thresholds.add(units);
    tiers.push({ quantity: units, price });
  }
  tiers.sort((left, right) => left.quantity - right.quantity);

  return {
    ...(minimum == null ? {} : { minimum, increment }),
    ...(maximum == null ? {} : { maximum }),
    ...(tiers.length ? { tiers } : {}),
  };
}

export function parseWholesaleCsv(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('CSV dosyası boş.');
  const rows = readCsv(text.replace(/^\ufeff/, ''));
  const header = rows.next().value?.map(normalize) ?? [];
  const columns = new Map(header.map((name, index) => [name, index]));
  const productColumn = columns.has('Product Published') ? 'Product Published' : 'Published';
  const required = [
    'Catalog Title', 'Handle', 'Option1 Name', 'Option1 Value', productColumn, 'Fixed Price', 'Compare At',
    'Quantity Increment', 'Minimum Order Quantity', 'Maximum Order Quantity',
  ];
  if (productColumn === 'Product Published') required.push('Variant Published');
  for (let index = 1; index <= 10; index += 1) {
    const quantity = `Quantity Break ${index}`;
    const price = `Price Break ${index}`;
    if (columns.has(quantity) || columns.has(price)) required.push(quantity, price);
  }
  if (columns.size !== header.length || required.some((name) => !columns.has(name))) {
    throw new Error('Shopify katalog CSV sütunları eksik veya yinelenmiş.');
  }

  const catalogs = new Map();
  let rowNumber = 1;
  for (const fields of rows) {
    rowNumber += 1;
    if (fields.every((value) => !value.trim())) continue;
    const invalid = (field) => new Error(`${rowNumber}. CSV kaydındaki ${field} geçersiz.`);
    if (fields.length !== header.length) throw invalid('sütun sayısı');
    const read = (name) => normalize(fields[columns.get(name)] ?? '');
    const title = read('Catalog Title');
    const handle = read('Handle');
    if (!title || !handle) throw invalid('katalog adı veya ürün tanıtıcısı');

    const options = [];
    for (let position = 1; position <= 3; position += 1) {
      const name = read(`Option${position} Name`);
      const value = read(`Option${position} Value`);
      if (!name && !value && position > 1) continue;
      if (!name || !value || options.length !== position - 1) throw invalid('varyant seçeneği');
      options.push([name, value]);
    }

    let catalog = catalogs.get(title);
    if (!catalog) {
      catalog = { title, products: Object.create(null) };
      catalogs.set(title, catalog);
    }
    const product = catalog.products[handle] ??= { published: null, variants: Object.create(null) };
    const productPublished = publication(read(productColumn), invalid);
    if (productPublished != null) {
      if (product.published != null && product.published !== productPublished) throw invalid('ürün yayın durumu');
      product.published = productPublished;
    }

    const key = wholesaleOptionKey(options);
    if (Object.hasOwn(product.variants, key)) throw invalid('yinelenen varyant');
    const sku = read('SKU');
    const price = money(read('Fixed Price'), 'sabit fiyat', invalid);
    const compareAt = money(read('Compare At'), 'karşılaştırma fiyatı', invalid);
    product.variants[key] = {
      published: publication(read('Variant Published'), invalid),
      ...(sku ? { sku } : {}),
      ...(price == null ? {} : { price }),
      ...(compareAt == null ? {} : { compareAt }),
      ...orderRules(read, invalid),
    };
  }

  if (!catalogs.size) throw new Error('CSV dosyasında ürün kaydı yok.');
  return { catalogs: [...catalogs.values()] };
}
