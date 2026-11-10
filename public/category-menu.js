const collator = new Intl.Collator('tr', { numeric: true, sensitivity: 'base' });
const number = new Intl.NumberFormat('tr-TR');
const imageHosts = new Set(['cdn.shopify.com', 'alacamdagitim.com']);
const stockPriority = { in: 3, case: 3, other: 3, unknown: 2, out: 1 };
const svgNamespace = 'http://www.w3.org/2000/svg';

function thumbnail(value, width = 360) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !imageHosts.has(url.hostname) || url.username || url.password) return null;
    url.searchParams.set('width', width);
    return url.href;
  } catch {
    return null;
  }
}

function addImage(images, value, priority) {
  const url = thumbnail(value);
  if (url && priority > (images.get(url) ?? 0)) images.set(url, priority);
}

export function catalogCategories(rows) {
  const categories = new Map();

  for (const row of rows) {
    if (typeof row.type !== 'string' || !row.type.trim() || !row.handle) continue;
    if (!categories.has(row.type)) categories.set(row.type, { handles: new Set(), images: new Map() });
    const { handles, images } = categories.get(row.type);
    handles.add(row.handle);
    addImage(images, row.image, stockPriority[row.stock] ?? stockPriority.unknown);
    for (const variant of row.variants ?? []) {
      if (variant.available) addImage(images, variant.image, stockPriority.in);
    }
  }

  return Array.from(categories, ([type, { handles, images }]) => {
    const [image = null, ...fallbackImages] = Array.from(images)
      .sort((first, second) => second[1] - first[1])
      .slice(0, 3)
      .map(([url]) => url);
    return { type, count: handles.size, image, fallbackImages };
  }).sort((first, second) => second.count - first.count || collator.compare(first.type, second.type));
}

function icon(doc, name) {
  const svg = doc.createElementNS(svgNamespace, 'svg');
  const use = doc.createElementNS(svgNamespace, 'use');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function cardMedia(doc, category, featured) {
  const media = doc.createElement('span');
  media.className = 'category-card-media';
  if (!category.image) {
    media.append(icon(doc, 'box'));
    return media;
  }

  const image = doc.createElement('img');
  const fallbacks = (category.fallbackImages ?? [])[Symbol.iterator]();
  const width = featured ? 360 : 120;
  image.alt = '';
  image.loading = featured ? 'eager' : 'lazy';
  image.decoding = 'async';
  image.addEventListener('error', () => {
    const next = fallbacks.next();
    if (next.done) media.replaceChildren(icon(doc, 'box'));
    else image.src = thumbnail(next.value, width);
  });
  image.src = thumbnail(category.image, width);
  media.append(image);
  return media;
}

function categoryCard(doc, category, featured) {
  const item = doc.createElement('li');
  const button = doc.createElement('button');
  const info = doc.createElement('span');
  const title = doc.createElement('span');
  const count = doc.createElement('span');
  const arrow = doc.createElement('span');

  item.className = 'category-tile';
  button.className = 'category-card';
  button.type = 'button';
  button.dataset.category = category.type;
  info.className = 'category-card-info';
  title.className = 'category-card-title';
  title.textContent = category.type;
  count.className = 'category-card-count';
  count.textContent = `${number.format(category.count)} ürün`;
  arrow.className = 'category-card-arrow';
  arrow.append(icon(doc, 'right'));

  info.append(title, count, arrow);
  button.append(cardMedia(doc, category, featured), info);
  item.append(button);
  return item;
}

export function renderCategoryCards(grid, categories, featured = false) {
  grid.replaceChildren(...categories.map((category) => categoryCard(grid.ownerDocument, category, featured)));
}
