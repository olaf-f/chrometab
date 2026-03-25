
let bookmarks = [];
let categories = [];
let currentCategory = '全部';
let operationHistory = [];
const bookmarkDragState = {
  draggingId: null
};
const categoryDragState = {
  draggingId: null
};
const categoryTreeState = {
  expandedIds: new Set()
};
const ROOT_FOLDER_NAMES = new Set(['书签栏', 'Bookmarks Bar', 'Bookmarks bar', 'Other bookmarks', 'Mobile bookmarks']);

const checkState = {
  running: false,
  stopRequested: false,
  rows: [],
  rowMap: new Map(),
  duplicates: [],
  selectedPreviewId: null,
  selectedFilter: 'all',
  uiRefreshTimer: null,
  uiRefreshAt: 0,
  task: {
    total: 0,
    processed: 0,
    valid: 0,
    invalid: 0,
    duplicate: 0
  }
};

function init() {
  loadData();
  renderCategories();
  renderBookmarks();
  setupEventListeners();
  restoreCheckConfig();
  rebuildCheckRowsFromBookmarks();
  renderCheckTree();
  renderCheckResults();
  updateCheckStats();
}

function loadData() {
  const savedBookmarks = localStorage.getItem('bookmarks');
  const savedCategories = localStorage.getItem('categories');

  bookmarks = savedBookmarks ? JSON.parse(savedBookmarks) : [];
  if (savedCategories) {
    categories = JSON.parse(savedCategories);
  } else {
    categories = [{ id: '1', name: '未分类', color: '#95a5a6', parentId: null, sortOrder: 1 }];
    saveCategories();
  }
  normalizeCategoryMeta();
  syncCategoryHierarchyFromStoredBookmarks();
}

function saveBookmarks() {
  localStorage.setItem('bookmarks', JSON.stringify(bookmarks));
}

function saveCategories() {
  localStorage.setItem('categories', JSON.stringify(categories));
}

function rebuildRowMap() {
  checkState.rowMap = new Map(checkState.rows.map((row) => [row.id, row]));
}

function scheduleCheckUiRefresh(force = false) {
  const now = Date.now();
  if (force) {
    if (checkState.uiRefreshTimer) {
      clearTimeout(checkState.uiRefreshTimer);
      checkState.uiRefreshTimer = null;
    }
    checkState.uiRefreshAt = now;
    updateCheckStats();
    renderCheckResults();
    return;
  }

  const intervalMs = 160;
  if (checkState.uiRefreshTimer) return;
  const waitMs = Math.max(0, intervalMs - (now - checkState.uiRefreshAt));
  checkState.uiRefreshTimer = setTimeout(() => {
    checkState.uiRefreshTimer = null;
    checkState.uiRefreshAt = Date.now();
    updateCheckStats();
    renderCheckResults();
  }, waitMs);
}

function snapshotBookmarks() {
  return bookmarks.map((b) => ({ ...b }));
}

function snapshotCategories() {
  return categories.map((c) => ({ ...c }));
}

function resetCategoriesToDefault() {
  categories = [{
    id: '1',
    name: '未分类',
    color: '#95a5a6',
    parentId: null,
    sortOrder: 1
  }];
}

function normalizeCategoryMeta() {
  categories = categories.map((c, idx) => {
    const rawOrder = Number(c.sortOrder);
    const sortOrder = Number.isFinite(rawOrder) ? rawOrder : idx + 1;
    return {
      ...c,
      parentId: c.parentId || null,
      sortOrder
    };
  });
}

function normalizeFolderPath(rawPath) {
  const arr = Array.isArray(rawPath) ? rawPath : String(rawPath || '').split('/');
  let parts = arr.map((s) => String(s || '').trim()).filter(Boolean);
  if (parts.length > 1 && ROOT_FOLDER_NAMES.has(parts[0])) parts = parts.slice(1);
  return parts;
}

function ensureCategoryPath(pathParts) {
  if (!pathParts || pathParts.length === 0) return null;
  let parentId = null;
  let changed = false;
  pathParts.forEach((name) => {
    let node = categories.find((c) => c.name === name);
    if (!node) {
      node = {
        id: generateId(),
        name,
        color: '#3498db',
        parentId,
        sortOrder: getNextCategorySortOrder(parentId),
        createdAt: new Date().toISOString()
      };
      categories.push(node);
      changed = true;
    } else if (parentId && !node.parentId) {
      node.parentId = parentId;
      changed = true;
    }
    parentId = node.id;
  });
  return changed;
}

function syncCategoryHierarchyFromStoredBookmarks() {
  let categoryChanged = false;
  let bookmarkChanged = false;

  bookmarks.forEach((b) => {
    const parts = normalizeFolderPath(b.originalPath);
    if (parts.length === 0) return;
    if (ensureCategoryPath(parts)) categoryChanged = true;

    const first = parts[0];
    const leaf = parts[parts.length - 1];
    if (leaf && first && b.category === first && leaf !== first) {
      b.category = leaf;
      b.updatedAt = new Date().toISOString();
      bookmarkChanged = true;
    }
  });

  if (categoryChanged) {
    normalizeCategoryMeta();
    saveCategories();
  }
  if (bookmarkChanged) saveBookmarks();
}

function getCategoryChildren(parentId) {
  return categories
    .filter((c) => (c.parentId || null) === (parentId || null))
    .sort((a, b) => {
      const ao = Number(a.sortOrder || 0);
      const bo = Number(b.sortOrder || 0);
      if (ao !== bo) return ao - bo;
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    });
}

function getDescendantCategoryNamesById(categoryId) {
  const result = [];
  const visited = new Set();
  const stack = [categoryId];
  const mapById = new Map(categories.map((c) => [c.id, c]));
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    const node = mapById.get(id);
    if (node) result.push(node.name);
    getCategoryChildren(id).forEach((child) => stack.push(child.id));
  }
  return result;
}

function hasCategoryChildren(categoryId) {
  return categories.some((c) => (c.parentId || null) === (categoryId || null));
}

function getCategoryScopeNames(selectedName) {
  if (!selectedName || selectedName === '全部') return null;
  const root = categories.find((c) => c.name === selectedName);
  if (!root) return new Set([selectedName]);
  return new Set(getDescendantCategoryNamesById(root.id));
}

function getNextCategorySortOrder(parentId) {
  const siblings = categories.filter((c) => (c.parentId || null) === (parentId || null));
  if (siblings.length === 0) return 1;
  const maxOrder = Math.max(...siblings.map((c) => Number(c.sortOrder || 0)));
  return maxOrder + 1;
}

function reorderCategorySiblings(draggingId, targetId) {
  if (!draggingId || !targetId || draggingId === targetId) return false;
  const dragging = categories.find((c) => c.id === draggingId);
  const target = categories.find((c) => c.id === targetId);
  if (!dragging || !target) return false;
  const parentId = dragging.parentId || null;
  if ((target.parentId || null) !== parentId) return false;

  const siblings = getCategoryChildren(parentId);
  const from = siblings.findIndex((c) => c.id === draggingId);
  const to = siblings.findIndex((c) => c.id === targetId);
  if (from < 0 || to < 0 || from === to) return false;

  const [item] = siblings.splice(from, 1);
  const insertAt = from < to ? to - 1 : to;
  siblings.splice(insertAt, 0, item);
  siblings.forEach((c, idx) => {
    const real = categories.find((x) => x.id === c.id);
    if (real) real.sortOrder = idx + 1;
  });
  return true;
}

function refreshLists() {
  renderCategories();
  renderBookmarks();
}

function getBookmarkIndexById(id) {
  return bookmarks.findIndex((b) => b.id === id);
}

function moveBookmarkBefore(draggingId, targetId) {
  if (!draggingId || !targetId || draggingId === targetId) return false;
  const from = getBookmarkIndexById(draggingId);
  const to = getBookmarkIndexById(targetId);
  if (from < 0 || to < 0) return false;
  const [item] = bookmarks.splice(from, 1);
  const insertAt = from < to ? to - 1 : to;
  bookmarks.splice(insertAt, 0, item);
  return true;
}

function moveBookmarkToCategory(bookmarkId, categoryName) {
  if (!bookmarkId || !categoryName || categoryName === '全部') return false;
  const idx = getBookmarkIndexById(bookmarkId);
  if (idx < 0) return false;
  if (bookmarks[idx].category === categoryName) return false;
  bookmarks[idx] = { ...bookmarks[idx], category: categoryName, updatedAt: new Date().toISOString() };
  return true;
}

function persistAfterBookmarkLayoutChange() {
  saveBookmarks();
  refreshLists();
  rebuildCheckRowsFromBookmarks();
  renderCheckTree();
  scheduleCheckUiRefresh(true);
}

function ensureCategoriesExist(categoryNames) {
  const existing = new Set(categories.map((c) => c.name));
  categoryNames.forEach((name) => {
    if (!name || existing.has(name)) return;
    categories.push({
      id: generateId(),
      name,
      color: '#3498db',
      parentId: null,
      createdAt: new Date().toISOString()
    });
    existing.add(name);
  });
}

function renderCategories() {
  const categoryList = document.getElementById('categoryList');
  if (!categoryList) return;
  categoryList.innerHTML = '';

  const allItem = document.createElement('li');
  allItem.innerHTML = `
    <button class="w-full text-left px-3 py-2 rounded-md category-drop-zone ${currentCategory === '全部' ? 'bg-primary text-white' : 'hover:bg-gray-100'} flex justify-between items-center" data-category="全部" data-drop-category="全部">
      <span>全部</span>
      <span id="totalBookmarks" class="bg-gray-200 text-gray-700 text-xs px-2 py-1 rounded-full">${bookmarks.length}</span>
    </button>
  `;
  categoryList.appendChild(allItem);

  const renderCategoryNode = (category, depth) => {
    const scopeNames = new Set(getDescendantCategoryNamesById(category.id));
    const count = bookmarks.filter((b) => scopeNames.has(b.category)).length;
    const hasChildren = hasCategoryChildren(category.id);
    const expanded = categoryTreeState.expandedIds.has(category.id);
    const item = document.createElement('li');
    const leftPad = 10 + depth * 18;
    item.innerHTML = `
      <div class="flex justify-between items-center category-sort-item rounded-md" data-category-id="${category.id}" draggable="true">
        <button class="w-full text-left px-3 py-2 rounded-md category-drop-zone ${currentCategory === category.name ? 'bg-primary text-white' : 'hover:bg-gray-100'} flex justify-between items-center flex-1 mr-2" data-category="${escapeAttr(category.name)}" data-drop-category="${escapeAttr(category.name)}" style="padding-left:${leftPad}px">
          <span class="flex items-center min-w-0 gap-1">
            <span class="toggle-children w-4 text-center ${hasChildren ? '' : 'text-transparent'}" data-id="${category.id}" role="button">${hasChildren ? (expanded ? '▼' : '▶') : '•'}</span>
            <span class="truncate">${escapeHtml(category.name)}</span>
          </span>
          <span class="bg-gray-200 text-gray-700 text-xs px-2 py-1 rounded-full">${count}</span>
        </button>
        <div class="flex space-x-1">
          <button class="edit-category px-2 py-1 text-gray-500 hover:text-primary" data-id="${category.id}"><i class="fa fa-pencil text-sm"></i></button>
          <button class="delete-category px-2 py-1 text-gray-500 hover:text-red-500" data-id="${category.id}"><i class="fa fa-trash text-sm"></i></button>
        </div>
      </div>
    `;
    categoryList.appendChild(item);

    if (expanded) getCategoryChildren(category.id).forEach((child) => renderCategoryNode(child, depth + 1));
  };

  const idSet = new Set(categories.map((c) => c.id));
  const roots = categories
    .filter((c) => !c.parentId || !idSet.has(c.parentId))
    .sort((a, b) => {
      const ao = Number(a.sortOrder || 0);
      const bo = Number(b.sortOrder || 0);
      if (ao !== bo) return ao - bo;
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    });
  roots.forEach((root) => renderCategoryNode(root, 0));

  document.querySelectorAll('#categoryList button[data-category]').forEach((button) => {
    button.addEventListener('click', () => {
      const selectedName = button.dataset.category || '全部';
      currentCategory = selectedName;
      const selected = categories.find((c) => c.name === selectedName);
      if (selected && hasCategoryChildren(selected.id)) categoryTreeState.expandedIds.add(selected.id);
      renderCategories();
      renderBookmarks();
    });
  });

  document.querySelectorAll('#categoryList .toggle-children[data-id]').forEach((toggle) => {
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = toggle.dataset.id;
      if (!id || !hasCategoryChildren(id)) return;
      if (categoryTreeState.expandedIds.has(id)) categoryTreeState.expandedIds.delete(id);
      else categoryTreeState.expandedIds.add(id);
      renderCategories();
    });
  });

  document.querySelectorAll('.edit-category').forEach((button) => {
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditCategoryModal(button.dataset.id);
    });
  });

  document.querySelectorAll('.delete-category').forEach((button) => {
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteCategory(button.dataset.id);
    });
  });

  updateCategorySelectors();
}

function updateCategorySelectors() {
  const selectors = [document.getElementById('manualCategory'), document.getElementById('editCategory')];
  selectors.forEach((selector) => {
    if (!selector) return;
    selector.innerHTML = '';
    categories.forEach((category) => {
      const option = document.createElement('option');
      option.value = category.name;
      option.textContent = category.name;
      selector.appendChild(option);
    });
  });

  const parentCategorySelector = document.getElementById('parentCategory');
  if (parentCategorySelector) {
    parentCategorySelector.innerHTML = '<option value="">无父分类</option>';
    categories.forEach((category) => {
      const option = document.createElement('option');
      option.value = category.id;
      option.textContent = category.name;
      parentCategorySelector.appendChild(option);
    });
  }
}

function renderBookmarks() {
  const bookmarkGrid = document.getElementById('bookmarkGrid');
  if (!bookmarkGrid) return;

  let filtered = bookmarks;
  if (currentCategory !== '全部') {
    const scopeNames = getCategoryScopeNames(currentCategory);
    if (scopeNames) filtered = bookmarks.filter((b) => scopeNames.has(b.category));
  }

  bookmarkGrid.innerHTML = '';
  if (filtered.length === 0) {
    bookmarkGrid.innerHTML = `
      <div class="col-span-full text-center py-12 text-gray-500">
        <i class="fa fa-bookmark-o text-4xl mb-3"></i>
        <p>暂无书签</p>
      </div>
    `;
    return;
  }

  filtered.forEach((bookmark) => {
    const row = checkState.rowMap.get(bookmark.id);
    const checkBadge = row
      ? row.finalStatus === 'valid'
        ? '<span class="badge-ok">有效</span>'
        : row.finalStatus === 'invalid'
          ? '<span class="badge-bad">失效</span>'
          : row.finalStatus === 'unknown'
            ? '<span class="badge-mid">未知</span>'
          : '<span class="badge-mid">未检测</span>'
      : '<span class="badge-mid">未检测</span>';

    const card = document.createElement('div');
    card.className = 'bookmark-card';
    card.draggable = true;
    card.dataset.bookmarkId = bookmark.id;
    card.innerHTML = `
      <div class="flex justify-between items-start mb-2 gap-2">
        <div class="flex items-center min-w-0">
          ${bookmark.favicon ? `<img src="${bookmark.favicon}" alt="favicon" class="w-4 h-4 mr-2">` : '<i class="fa fa-link w-4 h-4 mr-2 text-gray-400"></i>'}
          <h3 class="font-medium text-dark truncate">${escapeHtml(bookmark.title)}</h3>
        </div>
        <button class="text-gray-400 hover:text-primary edit-bookmark" data-id="${bookmark.id}"><i class="fa fa-pencil"></i></button>
      </div>
      <a href="${escapeAttr(bookmark.url)}" target="_blank" class="text-primary text-sm truncate mb-1 block hover:underline">${escapeHtml(bookmark.url)}</a>
      ${bookmark.originalPath ? `<div class="text-xs text-gray-500 mb-1">原始路径: ${escapeHtml(bookmark.originalPath)}</div>` : ''}
      <div class="flex justify-between items-center">
        <span class="text-xs text-gray-500">${escapeHtml(bookmark.category || '未分类')}</span>
        ${checkBadge}
      </div>
    `;
    bookmarkGrid.appendChild(card);
  });

  document.querySelectorAll('.edit-bookmark').forEach((button) => {
    button.addEventListener('click', () => openEditBookmarkModal(button.dataset.id));
  });
}

function openEditBookmarkModal(bookmarkId) {
  const bookmark = bookmarks.find((b) => b.id === bookmarkId);
  if (!bookmark) return;
  document.getElementById('editBookmarkId').value = bookmark.id;
  document.getElementById('editTitle').value = bookmark.title;
  document.getElementById('editUrl').value = bookmark.url;
  document.getElementById('editCategory').value = bookmark.category;
  document.getElementById('editBookmarkModal').classList.remove('hidden');
}

function parseChromeBookmarks(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const parsedBookmarks = [];

  function walk(node, path = []) {
    const tag = (node.tagName || '').toUpperCase();

    if (tag === 'A') {
      const title = (node.textContent || '').trim();
      const url = (node.getAttribute('href') || '').trim();
      if (title && /^https?:\/\//i.test(url)) {
        let favicon = '';
        try {
          favicon = `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=16`;
        } catch (_) {
          favicon = '';
        }
        const folderPath = normalizeFolderPath(path);
        const category = folderPath.length > 0 ? folderPath[folderPath.length - 1] : '未分类';
        parsedBookmarks.push({
          id: generateId(),
          title,
          url,
          category,
          categoryPath: folderPath,
          favicon,
          originalPath: folderPath.join('/'),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
      return;
    }

    if (tag === 'H3') {
      const folderName = (node.textContent || '').trim();
      let dl = node.nextElementSibling;
      while (dl && (dl.tagName || '').toUpperCase() !== 'DL') {
        dl = dl.nextElementSibling;
      }
      if (dl) {
        Array.from(dl.children).forEach((child) => walk(child, [...path, folderName]));
      }
      return;
    }

    Array.from(node.children || []).forEach((child) => walk(child, path));
  }

  const rootDL = doc.querySelector('dl');
  if (rootDL) {
    Array.from(rootDL.children).forEach((child) => walk(child, []));
  }
  return dedupeBookmarks(parsedBookmarks);
}

function dedupeBookmarks(items) {
  const set = new Set();
  const result = [];
  items.forEach((item) => {
    const key = normalizeDuplicateUrl(item.url);
    if (!key || set.has(key)) return;
    set.add(key);
    result.push(item);
  });
  return result;
}

function generateId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}

function openEditCategoryModal(categoryId) {
  const category = categories.find((c) => c.id === categoryId);
  if (!category) return;
  document.getElementById('categoryName').value = category.name;
  document.getElementById('categoryColor').value = category.color;

  const parent = document.getElementById('parentCategory');
  if (parent) {
    parent.innerHTML = '<option value="">无父分类</option>';
    categories.forEach((c) => {
      if (c.id === category.id) return;
      const option = document.createElement('option');
      option.value = c.id;
      option.textContent = c.name;
      if (c.id === category.parentId) option.selected = true;
      parent.appendChild(option);
    });
  }

  const saveButton = document.getElementById('saveCategoryBtn');
  saveButton.dataset.editId = category.id;
  document.getElementById('addCategoryModal').classList.remove('hidden');
}

function resetCategoryModalState() {
  const saveButton = document.getElementById('saveCategoryBtn');
  delete saveButton.dataset.editId;
  document.getElementById('categoryName').value = '';
  document.getElementById('categoryColor').value = '#3498db';
  const parent = document.getElementById('parentCategory');
  if (parent) parent.value = '';
}

function deleteCategory(categoryId) {
  const category = categories.find((c) => c.id === categoryId);
  if (!category) return;
  if (!confirm('确定要删除这个分类吗？该分类下书签会转移到“未分类”。')) return;

  operationHistory.push({
    type: 'deleteCategory',
    category: { ...category },
    prevBookmarks: snapshotBookmarks(),
    prevCategories: snapshotCategories(),
    prevCurrentCategory: currentCategory,
    timestamp: new Date().toISOString()
  });
  bookmarks = bookmarks.map((b) => (b.category === category.name ? { ...b, category: '未分类' } : b));
  categories = categories
    .filter((c) => c.id !== categoryId)
    .map((c) => (c.parentId === categoryId ? { ...c, parentId: category.parentId || null } : c));
  if (currentCategory === category.name) currentCategory = '全部';

  normalizeCategoryMeta();
  saveCategories();
  saveBookmarks();
  refreshLists();
  rebuildCheckRowsFromBookmarks();
}

function setTab(activeTab) {
  const bookmarksSection = document.getElementById('bookmarksSection');
  const checkerSection = document.getElementById('checkerSection');
  const tabBookmarksBtn = document.getElementById('tabBookmarksBtn');
  const tabCheckerBtn = document.getElementById('tabCheckerBtn');

  if (activeTab === 'checker') {
    bookmarksSection.classList.add('hidden');
    checkerSection.classList.remove('hidden');
    tabBookmarksBtn.classList.remove('tab-btn-active');
    tabBookmarksBtn.classList.add('tab-btn-normal');
    tabCheckerBtn.classList.remove('tab-btn-normal');
    tabCheckerBtn.classList.add('tab-btn-active');
    renderCheckTree();
    renderCheckResults();
    updateCheckStats();
    return;
  }

  checkerSection.classList.add('hidden');
  bookmarksSection.classList.remove('hidden');
  tabCheckerBtn.classList.remove('tab-btn-active');
  tabCheckerBtn.classList.add('tab-btn-normal');
  tabBookmarksBtn.classList.remove('tab-btn-normal');
  tabBookmarksBtn.classList.add('tab-btn-active');
}

function normalizeUrl(raw) {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    const removeKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'spm'];
    removeKeys.forEach((k) => u.searchParams.delete(k));
    return u.toString();
  } catch (_) {
    return raw.trim().toLowerCase();
  }
}

function normalizeDuplicateUrl(raw) {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch (_) {
    return String(raw || '').trim();
  }
}

function rebuildCheckRowsFromBookmarks() {
  const oldMap = new Map(checkState.rows.map((r) => [r.id, r]));
  checkState.rows = bookmarks.map((b, idx) => {
    const old = oldMap.get(b.id);
    return {
      id: b.id,
      index: idx + 1,
      folder: b.originalPath || b.category || '未分类',
      category: b.category || '未分类',
      title: b.title,
      url: b.url,
      normalizedUrl: normalizeUrl(b.url),
      duplicateKey: normalizeDuplicateUrl(b.url),
      selected: false,
      attempts: old?.attempts || [],
      finalStatus: old?.finalStatus || 'unchecked',
      latencyMs: old?.latencyMs || null,
      reason: old?.reason || '',
      sourceType: 'library',
      sourceBookmarkId: b.id,
      isDuplicate: false,
      duplicateGroup: null
    };
  });
  rebuildRowMap();
  recomputeDuplicates();
}

function recomputeDuplicates() {
  const groupMap = new Map();
  checkState.rows.forEach((row) => {
    const key = row.duplicateKey || row.normalizedUrl;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(row);
  });

  checkState.duplicates = [];
  checkState.rows.forEach((row) => {
    row.isDuplicate = false;
    row.duplicateGroup = null;
  });

  groupMap.forEach((rows, key) => {
    if (!key || rows.length <= 1) return;
    rows.forEach((row, idx) => {
      row.isDuplicate = true;
      row.duplicateGroup = key;
      if (idx > 0) checkState.duplicates.push(row);
    });
  });
}
function renderCheckTree() {
  const tree = document.getElementById('checkTree');
  if (!tree) return;

  const folderMap = new Map();
  checkState.rows.forEach((r) => {
    const key = r.folder || '未分类';
    if (!folderMap.has(key)) folderMap.set(key, { total: 0, valid: 0, invalid: 0 });
    const s = folderMap.get(key);
    s.total += 1;
    if (r.finalStatus === 'valid') s.valid += 1;
    if (r.finalStatus === 'invalid') s.invalid += 1;
  });

  if (folderMap.size === 0) {
    tree.innerHTML = '<p class="text-gray-500">暂无数据</p>';
    return;
  }

  tree.innerHTML = Array.from(folderMap.entries())
    .map(([name, s]) => `
      <div class="mb-2 border border-gray-200 rounded p-2">
        <div class="font-medium break-all">${escapeHtml(name)}</div>
        <div class="text-xs text-gray-600 mt-1">共 ${s.total} | 有效 ${s.valid} | 失效 ${s.invalid}</div>
      </div>
    `)
    .join('');
}

function renderCheckResults() {
  const body = document.getElementById('checkResultsBody');
  if (!body) return;

  const filter = checkState.selectedFilter;
  let rows = checkState.rows;
  if (filter === 'valid') rows = rows.filter((r) => r.finalStatus === 'valid');
  if (filter === 'invalid') rows = rows.filter((r) => r.finalStatus === 'invalid');
  if (filter === 'unknown') rows = rows.filter((r) => r.finalStatus === 'unknown');
  if (filter === 'duplicate') rows = rows.filter((r) => r.isDuplicate);
  if (filter === 'unchecked') rows = rows.filter((r) => r.finalStatus === 'unchecked');

  if (rows.length === 0) {
    body.innerHTML = '<tr><td class="p-3 text-center text-gray-500" colspan="8">暂无结果</td></tr>';
    return;
  }

  body.innerHTML = rows
    .map((row) => {
      const attempts = [0, 1, 2].map((i) => {
        const a = row.attempts[i];
        if (!a) return '-';
        if (a.ok === null) return '<span class="text-yellow-600">?</span>';
        return a.ok ? '<span class="text-green-600">√</span>' : '<span class="text-red-600">×</span>';
      });
      const statusBadge = row.finalStatus === 'valid'
        ? '<span class="badge-ok">有效</span>'
        : row.finalStatus === 'invalid'
          ? '<span class="badge-bad">失效</span>'
          : row.finalStatus === 'unknown'
            ? '<span class="badge-mid">未知</span>'
          : '<span class="badge-mid">未检测</span>';

      return `
        <tr class="border-b hover:bg-gray-50 cursor-pointer" data-row-id="${row.id}">
          <td class="p-2"><input type="checkbox" class="row-selector" data-id="${row.id}" ${row.selected ? 'checked' : ''}></td>
          <td class="p-2 max-w-[160px] truncate" title="${escapeAttr(row.folder)}">${escapeHtml(row.folder)}</td>
          <td class="p-2 max-w-[160px] truncate" title="${escapeAttr(row.title)}">${escapeHtml(row.title)}</td>
          <td class="p-2 max-w-[220px] truncate" title="${escapeAttr(row.url)}">${escapeHtml(row.url)}</td>
          <td class="p-2 text-center">${attempts[0]}</td>
          <td class="p-2 text-center">${attempts[1]}</td>
          <td class="p-2 text-center">${attempts[2]}</td>
          <td class="p-2 text-center">${statusBadge}</td>
        </tr>
      `;
    })
    .join('');

}

function renderPreview(row) {
  const panel = document.getElementById('previewPanel');
  if (!panel) return;
  if (!row) {
    panel.innerHTML = '<p class="text-gray-500">点击结果行查看详情</p>';
    return;
  }

  panel.innerHTML = `
    <div><b>标题:</b> ${escapeHtml(row.title)}</div>
    <div><b>分类:</b> ${escapeHtml(row.category || '未分类')}</div>
    <div><b>状态:</b> ${row.finalStatus === 'valid' ? '有效' : row.finalStatus === 'invalid' ? '失效' : row.finalStatus === 'unknown' ? '未知' : '未检测'}</div>
    <div><b>耗时:</b> ${row.latencyMs || '-'} ms</div>
    <div><b>原因:</b> ${escapeHtml(row.reason || '-')}</div>
    <div class="break-all"><b>URL:</b> <a class="text-primary underline" href="${escapeAttr(row.url)}" target="_blank">${escapeHtml(row.url)}</a></div>
  `;
}

function updateCheckStats() {
  const rows = checkState.rows;
  const total = rows.length;
  const valid = rows.filter((r) => r.finalStatus === 'valid').length;
  const invalid = rows.filter((r) => r.finalStatus === 'invalid').length;
  const duplicate = checkState.duplicates.length;

  checkState.task.total = total;
  checkState.task.valid = valid;
  checkState.task.invalid = invalid;
  checkState.task.duplicate = duplicate;

  setText('statTotal', total);
  setText('statValid', valid);
  setText('statInvalid', invalid);
  setText('statDuplicate', duplicate);
  setText('statProgress', `${checkState.task.processed}/${checkState.task.total}`);
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(text);
}

async function runCheck(mode) {
  if (checkState.running) {
    alert('检测任务正在运行中');
    return;
  }
  if (checkState.rows.length === 0) {
    alert('当前没有可检测的数据，请先导入书签');
    return;
  }

  const concurrency = clampInt(document.getElementById('checkConcurrency').value, 1, 200, 20);
  const timeoutSec = clampInt(document.getElementById('checkTimeout').value, 1, 60, 10);
  const retries = clampInt(document.getElementById('checkRetries').value, 1, 3, 3);
  saveCheckConfig({ concurrency, timeoutSec, retries });

  let targets = checkState.rows;
  if (mode === 'failed') {
    targets = checkState.rows.filter((r) => r.finalStatus === 'invalid' || r.finalStatus === 'unchecked' || r.finalStatus === 'unknown');
  }
  if (mode === 'invalidOnly') {
    targets = checkState.rows.filter((r) => r.finalStatus === 'invalid');
  }

  if (targets.length === 0) {
    alert('没有需要检测的记录');
    return;
  }

  checkState.running = true;
  checkState.stopRequested = false;
  checkState.task.processed = 0;
  scheduleCheckUiRefresh(true);

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }).map(async () => {
    while (true) {
      if (checkState.stopRequested) return;
      const idx = cursor;
      cursor += 1;
      if (idx >= targets.length) return;
      const row = targets[idx];
      const result = await checkUrlWithRetries(row.url, retries, timeoutSec * 1000);
      row.attempts = result.attempts;
      row.latencyMs = result.latencyMs;
      row.finalStatus = result.status;
      row.reason = result.reason;
      checkState.task.processed += 1;
      scheduleCheckUiRefresh(false);
      if (checkState.selectedPreviewId === row.id) renderPreview(row);
    }
  });

  await Promise.all(workers);
  checkState.running = false;
  recomputeDuplicates();
  renderCheckTree();
  scheduleCheckUiRefresh(true);
  renderBookmarks();
  alert(checkState.stopRequested ? '检测已停止' : '检测完成');
}

function stopCheck() {
  if (!checkState.running) return;
  checkState.stopRequested = true;
}

async function checkUrlWithRetries(url, retries, timeoutMs) {
  const attempts = [];
  let totalTime = 0;
  let lastReason = '未知错误';
  let hasUnknown = false;

  for (let i = 1; i <= retries; i += 1) {
    const start = Date.now();
    try {
      const probe = await checkUrlReachable(url, timeoutMs);
      const duration = Date.now() - start;
      totalTime += duration;
      if (probe.status === 'valid') {
        attempts.push({ attemptNo: i, ok: true, durationMs: duration, reason: probe.reason || '' });
        return {
          status: 'valid',
          attempts,
          latencyMs: Math.round(totalTime / attempts.length),
          reason: probe.reason || ''
        };
      }
      if (probe.status === 'unknown') {
        const reason = probe.reason || '跨域限制，结果未知';
        attempts.push({ attemptNo: i, ok: null, durationMs: duration, reason });
        lastReason = reason;
        continue;
      }
      const reason = probe.reason || '请求失败';
      attempts.push({ attemptNo: i, ok: false, durationMs: duration, reason });
      lastReason = reason;
    } catch (err) {
      const duration = Date.now() - start;
      totalTime += duration;
      const reason = err && err.message ? err.message : '网络错误';
      // 浏览器安全策略、插件拦截或站点反爬可能抛出 Failed to fetch，
      // 这类情况无法直接判定链接失效，按“未知”处理，避免误杀可访问链接。
      if (String(reason).toLowerCase().includes('failed to fetch')) {
        hasUnknown = true;
        const unknownReason = '浏览器限制或站点拦截，无法直接判定';
        attempts.push({ attemptNo: i, ok: null, durationMs: duration, reason: unknownReason });
        lastReason = unknownReason;
      } else {
        attempts.push({ attemptNo: i, ok: false, durationMs: duration, reason });
        lastReason = reason;
      }
    }
  }

  return {
    status: hasUnknown ? 'unknown' : 'invalid',
    attempts,
    latencyMs: Math.round(totalTime / attempts.length),
    reason: lastReason
  };
}

async function checkUrlReachable(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    try {
      const headRes = await fetch(url, {
        method: 'HEAD',
        mode: 'no-cors',
        redirect: 'follow',
        signal: controller.signal,
        cache: 'no-store'
      });
      if (headRes.ok) return { status: 'valid', reason: '' };
      if (headRes.type === 'opaque') return { status: 'valid', reason: '跨域限制，按可达处理' };
    } catch (_) {
      // HEAD 失败后尝试 GET
    }

    const getRes = await fetch(url, {
      method: 'GET',
      mode: 'no-cors',
      redirect: 'follow',
      signal: controller.signal,
      cache: 'no-store'
    });
    if (getRes.ok) return { status: 'valid', reason: '' };
    if (getRes.type === 'opaque') return { status: 'valid', reason: '跨域限制，按可达处理' };
    return { status: 'invalid', reason: `HTTP ${getRes.status || 0}` };
  } finally {
    clearTimeout(timer);
  }
}

function deleteInvalidLinks() {
  const invalidRows = checkState.rows.filter((r) => r.finalStatus === 'invalid');
  if (invalidRows.length === 0) {
    alert('当前没有失效链接');
    return;
  }

  const libraryInvalidIds = new Set(
    invalidRows
      .filter((r) => r.sourceType !== 'workspace' && r.sourceBookmarkId)
      .map((r) => r.sourceBookmarkId)
  );
  const workspaceInvalidRowIds = new Set(
    invalidRows
      .filter((r) => r.sourceType === 'workspace')
      .map((r) => r.id)
  );

  const confirmMessage = libraryInvalidIds.size > 0 && workspaceInvalidRowIds.size > 0
    ? `确认删除失效链接吗？主书签库 ${libraryInvalidIds.size} 条，检测工作台 ${workspaceInvalidRowIds.size} 条。`
    : libraryInvalidIds.size > 0
      ? `确认从主书签库删除 ${libraryInvalidIds.size} 条失效链接吗？`
      : `确认从检测工作台删除 ${workspaceInvalidRowIds.size} 条失效链接吗？`;
  if (!confirm(confirmMessage)) return;

  if (libraryInvalidIds.size > 0) {
    bookmarks = bookmarks.filter((b) => !libraryInvalidIds.has(b.id));
    saveBookmarks();
    rebuildCheckRowsFromBookmarks();
  } else {
    checkState.rows = checkState.rows.filter((r) => !workspaceInvalidRowIds.has(r.id));
    rebuildRowMap();
  }

  recomputeDuplicates();
  renderCategories();
  renderBookmarks();
  renderCheckTree();
  renderCheckResults();
  updateCheckStats();
}

function exportCheckedBookmarks() {
  const html = generateBookmarksHTML(bookmarks);
  downloadHtml(html, `bookmarks_checked_${today()}.html`);
}

function generateBookmarksHTML(source = bookmarks) {
  const byCategory = {};
  source.forEach((b) => {
    const key = b.category || '未分类';
    if (!byCategory[key]) byCategory[key] = [];
    byCategory[key].push(b);
  });

  let html = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n';
  html += '<!-- This is an automatically generated file. -->\n';
  html += '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n';
  html += '<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n';

  Object.keys(byCategory).forEach((category) => {
    html += `<DT><H3>${escapeHtml(category)}</H3>\n<DL><p>\n`;
    byCategory[category].forEach((b) => {
      html += `<DT><A HREF="${escapeAttr(b.url)}">${escapeHtml(b.title)}</A>\n`;
    });
    html += '</DL><p>\n';
  });
  html += '</DL><p>';
  return html;
}

function downloadHtml(content, fileName) {
  const blob = new Blob([content], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function openDuplicatesModal() {
  recomputeDuplicates();
  const body = document.getElementById('duplicatesBody');
  if (!body) return;

  if (checkState.duplicates.length === 0) {
    body.innerHTML = '<tr><td colspan="5" class="p-3 text-center text-gray-500">没有重复项</td></tr>';
  } else {
    body.innerHTML = checkState.duplicates
      .map((r) => `
        <tr class="border-b">
          <td class="p-2"><input type="checkbox" class="dup-selector" data-id="${r.id}" checked></td>
          <td class="p-2">${escapeHtml(r.category || '未分类')}</td>
          <td class="p-2">${escapeHtml(r.title)}</td>
          <td class="p-2 max-w-[320px] truncate" title="${escapeAttr(r.url)}">${escapeHtml(r.url)}</td>
          <td class="p-2">${r.index}</td>
        </tr>
      `)
      .join('');
  }
  document.getElementById('duplicatesModal').classList.remove('hidden');
}

function removeSelectedDuplicates() {
  const checked = Array.from(document.querySelectorAll('.dup-selector:checked')).map((el) => el.dataset.id);
  if (checked.length === 0) {
    alert('请先选择要删除的重复项');
    return;
  }
  const idSet = new Set(checked);
  bookmarks = bookmarks.filter((b) => !idSet.has(b.id));
  saveBookmarks();
  rebuildCheckRowsFromBookmarks();
  renderCategories();
  renderBookmarks();
  renderCheckTree();
  renderCheckResults();
  updateCheckStats();
  document.getElementById('duplicatesModal').classList.add('hidden');
  alert(`已删除 ${checked.length} 条重复书签`);
}
function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.add('hidden');
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('hidden');
}

function saveCheckConfig(config) {
  localStorage.setItem('checkConfig', JSON.stringify(config));
}

function restoreCheckConfig() {
  const saved = localStorage.getItem('checkConfig');
  if (!saved) return;
  try {
    const cfg = JSON.parse(saved);
    if (cfg.concurrency) document.getElementById('checkConcurrency').value = cfg.concurrency;
    if (cfg.timeoutSec) document.getElementById('checkTimeout').value = cfg.timeoutSec;
    if (cfg.retries) document.getElementById('checkRetries').value = cfg.retries;
  } catch (_) {
    // ignore parse error
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function escapeHtml(input) {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(input) {
  return escapeHtml(input).replace(/`/g, '&#96;');
}

function setupEventListeners() {
  document.getElementById('tabBookmarksBtn').addEventListener('click', () => setTab('bookmarks'));
  document.getElementById('tabCheckerBtn').addEventListener('click', () => setTab('checker'));

  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('[id^="close"]');
    if (!closeBtn) return;
    const id = closeBtn.id;
    if (id === 'closeImportModal') closeModal('importModal');
    if (id === 'closeSettingsModal' || id === 'closeSettingsBottomBtn') closeModal('settingsModal');
    if (id === 'closeEditBookmarkModal') closeModal('editBookmarkModal');
    if (id === 'closeAddCategoryModal') {
      resetCategoryModalState();
      closeModal('addCategoryModal');
    }
    if (id === 'closeDuplicatesModal') closeModal('duplicatesModal');
  });

  document.querySelectorAll('[id$="Modal"]').forEach((modal) => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  });

  document.getElementById('importBtn').addEventListener('click', () => openModal('importModal'));
  document.getElementById('settingsBtn').addEventListener('click', () => openModal('settingsModal'));
  document.getElementById('addCategoryBtn').addEventListener('click', () => {
    resetCategoryModalState();
    openModal('addCategoryModal');
  });
  document.getElementById('addBookmarkBtn').addEventListener('click', () => openModal('importModal'));

  document.getElementById('importFileBtn').addEventListener('click', () => {
    const file = document.getElementById('bookmarkFile').files[0];
    if (!file) {
      alert('请选择 Chrome 书签 HTML 文件');
      return;
    }
    const prevBookmarks = snapshotBookmarks();
    const prevCategories = snapshotCategories();
    const prevCurrentCategory = currentCategory;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const parsed = parseChromeBookmarks(String(evt.target.result || ''));
      if (parsed.length === 0) {
        alert('未解析到有效书签，请确认文件格式');
        return;
      }

      const existingMap = new Map();
      bookmarks.forEach((b) => {
        const key = normalizeDuplicateUrl(b.url);
        if (!key) return;
        if (!existingMap.has(key)) existingMap.set(key, []);
        existingMap.get(key).push(b);
      });
      const duplicates = [];
      const unique = [];

      parsed.forEach((item) => {
        const key = normalizeDuplicateUrl(item.url);
        const oldList = existingMap.get(key);
        if (oldList && oldList.length > 0) duplicates.push({ olds: oldList, item });
        else unique.push(item);
      });

      if (duplicates.length > 0) {
        const shouldOverwrite = confirm(`检测到 ${duplicates.length} 个重复书签，是否覆盖现有书签？`);
        if (shouldOverwrite) {
          const removeIds = new Set();
          duplicates.forEach(({ olds, item }) => {
            const [keep, ...extras] = olds;
            const idx = bookmarks.findIndex((b) => b.id === keep.id);
            if (idx >= 0) bookmarks[idx] = { ...item, id: keep.id };
            extras.forEach((extra) => removeIds.add(extra.id));
          });
          if (removeIds.size > 0) {
            bookmarks = bookmarks.filter((b) => !removeIds.has(b.id));
          }
        }
      }

      bookmarks = [...bookmarks, ...unique];
      ensureCategoriesExist(parsed.map((p) => p.category));
      syncCategoryHierarchyFromStoredBookmarks();
      saveBookmarks();
      saveCategories();

      operationHistory.push({
        type: 'import',
        prevBookmarks,
        prevCategories,
        prevCurrentCategory,
        timestamp: new Date().toISOString()
      });

      currentCategory = '全部';
      document.getElementById('searchInput').value = '';
      refreshLists();
      rebuildCheckRowsFromBookmarks();
      renderCheckTree();
      renderCheckResults();
      updateCheckStats();
      closeModal('importModal');
      alert(`成功导入 ${unique.length} 个书签，${duplicates.length} 个重复书签`);
    };
    reader.readAsText(file);
  });

  document.getElementById('addManualBtn').addEventListener('click', () => {
    const title = document.getElementById('manualTitle').value.trim();
    const url = document.getElementById('manualUrl').value.trim();
    const category = document.getElementById('manualCategory').value || '未分类';

    if (!title || !url) {
      alert('请填写网站标题和 URL');
      return;
    }

    let favicon = '';
    try {
      favicon = `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=16`;
    } catch (_) {
      favicon = '';
    }

    const row = {
      id: generateId(),
      title,
      url,
      category,
      favicon,
      originalPath: '手动添加',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    bookmarks.push(row);
    operationHistory.push({ type: 'add', bookmark: row, timestamp: new Date().toISOString() });
    saveBookmarks();
    refreshLists();
    rebuildCheckRowsFromBookmarks();
    renderCheckTree();
    renderCheckResults();
    updateCheckStats();
    document.getElementById('manualTitle').value = '';
    document.getElementById('manualUrl').value = '';
    alert('书签添加成功');
  });

  document.getElementById('saveBookmarkBtn').addEventListener('click', () => {
    const id = document.getElementById('editBookmarkId').value;
    const title = document.getElementById('editTitle').value.trim();
    const url = document.getElementById('editUrl').value.trim();
    const category = document.getElementById('editCategory').value;

    if (!title || !url) {
      alert('请填写网站标题和 URL');
      return;
    }

    const idx = bookmarks.findIndex((b) => b.id === id);
    if (idx < 0) return;

    const oldBookmark = { ...bookmarks[idx] };
    let favicon = bookmarks[idx].favicon;
    try {
      favicon = `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=16`;
    } catch (_) {
      // keep old favicon
    }

    bookmarks[idx] = { ...bookmarks[idx], title, url, category, favicon, updatedAt: new Date().toISOString() };
    operationHistory.push({ type: 'update', oldBookmark, newBookmark: { ...bookmarks[idx] }, timestamp: new Date().toISOString() });
    saveBookmarks();
    refreshLists();
    rebuildCheckRowsFromBookmarks();
    renderCheckTree();
    renderCheckResults();
    updateCheckStats();
    closeModal('editBookmarkModal');
    alert('书签更新成功');
  });

  document.getElementById('deleteBookmarkBtn').addEventListener('click', () => {
    if (!confirm('确定要删除这个书签吗？')) return;
    const id = document.getElementById('editBookmarkId').value;
    const found = bookmarks.find((b) => b.id === id);
    if (!found) return;

    operationHistory.push({ type: 'delete', bookmark: found, timestamp: new Date().toISOString() });
    bookmarks = bookmarks.filter((b) => b.id !== id);
    saveBookmarks();
    refreshLists();
    rebuildCheckRowsFromBookmarks();
    renderCheckTree();
    renderCheckResults();
    updateCheckStats();
    closeModal('editBookmarkModal');
    alert('书签删除成功');
  });

  document.getElementById('saveCategoryBtn').addEventListener('click', () => {
    const name = document.getElementById('categoryName').value.trim();
    const color = document.getElementById('categoryColor').value;
    const parentId = document.getElementById('parentCategory').value || null;
    const saveBtn = document.getElementById('saveCategoryBtn');
    const editId = saveBtn.dataset.editId;

    if (!name) {
      alert('请填写分类名称');
      return;
    }

    const exists = categories.find((c) => c.name === name && c.id !== editId);
    if (exists) {
      alert('分类名称已存在');
      return;
    }

    if (editId) {
      const idx = categories.findIndex((c) => c.id === editId);
      if (idx < 0) return;
      const oldName = categories[idx].name;
      const parentChanged = (categories[idx].parentId || null) !== parentId;
      categories[idx] = {
        ...categories[idx],
        name,
        color,
        parentId,
        sortOrder: parentChanged ? getNextCategorySortOrder(parentId) : categories[idx].sortOrder,
        updatedAt: new Date().toISOString()
      };
      if (oldName !== name) {
        bookmarks = bookmarks.map((b) => (b.category === oldName ? { ...b, category: name } : b));
        if (currentCategory === oldName) currentCategory = name;
        saveBookmarks();
      }
      normalizeCategoryMeta();
      saveCategories();
      refreshLists();
      rebuildCheckRowsFromBookmarks();
      closeModal('addCategoryModal');
      resetCategoryModalState();
      alert('分类更新成功');
      return;
    }

    categories.push({
      id: generateId(),
      name,
      color,
      parentId,
      sortOrder: getNextCategorySortOrder(parentId),
      createdAt: new Date().toISOString()
    });
    normalizeCategoryMeta();
    saveCategories();
    refreshLists();
    closeModal('addCategoryModal');
    resetCategoryModalState();
    alert('分类添加成功');
  });

  document.getElementById('exportBtn').addEventListener('click', () => {
    const html = generateBookmarksHTML(bookmarks);
    downloadHtml(html, `bookmarks_${today()}.html`);
    alert('书签导出成功');
  });

  document.getElementById('clearBtn').addEventListener('click', () => {
    if (!confirm('确定要清空所有书签吗？此操作不可恢复。')) return;
    operationHistory.push({
      type: 'clear',
      prevBookmarks: snapshotBookmarks(),
      prevCategories: snapshotCategories(),
      prevCurrentCategory: currentCategory,
      timestamp: new Date().toISOString()
    });
    bookmarks = [];
    resetCategoriesToDefault();
    categoryTreeState.expandedIds.clear();
    currentCategory = '全部';
    saveBookmarks();
    saveCategories();
    refreshLists();
    rebuildCheckRowsFromBookmarks();
    renderCheckTree();
    renderCheckResults();
    updateCheckStats();
    alert('所有书签与分类已清空');
  });

  document.getElementById('undoBtn').addEventListener('click', () => {
    if (operationHistory.length === 0) {
      alert('没有可撤销的操作');
      return;
    }
    const op = operationHistory.pop();
    if (op.type === 'add') bookmarks = bookmarks.filter((b) => b.id !== op.bookmark.id);
    if (op.type === 'delete') bookmarks.push(op.bookmark);
    if (op.type === 'update') {
      const idx = bookmarks.findIndex((b) => b.id === op.oldBookmark.id);
      if (idx >= 0) bookmarks[idx] = op.oldBookmark;
    }
    if (op.type === 'import') {
      bookmarks = (op.prevBookmarks || []).map((b) => ({ ...b }));
      categories = (op.prevCategories || categories).map((c) => ({ ...c }));
      currentCategory = op.prevCurrentCategory || '全部';
      saveCategories();
    }
    if (op.type === 'deleteCategory') {
      bookmarks = (op.prevBookmarks || []).map((b) => ({ ...b }));
      categories = (op.prevCategories || categories).map((c) => ({ ...c }));
      currentCategory = op.prevCurrentCategory || '全部';
      saveCategories();
    }
    if (op.type === 'clear') {
      bookmarks = (op.prevBookmarks || []).map((b) => ({ ...b }));
      categories = (op.prevCategories || categories).map((c) => ({ ...c }));
      normalizeCategoryMeta();
      currentCategory = op.prevCurrentCategory || '全部';
      saveCategories();
    }

    saveBookmarks();
    refreshLists();
    rebuildCheckRowsFromBookmarks();
    renderCheckTree();
    renderCheckResults();
    updateCheckStats();
    alert('操作已撤销');
  });

  document.getElementById('searchInput').addEventListener('input', (e) => {
    const key = e.target.value.trim().toLowerCase();
    document.querySelectorAll('.bookmark-card').forEach((card) => {
      const text = card.textContent.toLowerCase();
      card.style.display = text.includes(key) ? 'block' : 'none';
    });
  });

  document.getElementById('themeSelect').addEventListener('change', (e) => {
    if (e.target.value === 'dark') {
      document.body.classList.add('bg-gray-900', 'text-white');
      document.body.classList.remove('bg-neutral');
      return;
    }
    document.body.classList.add('bg-neutral');
    document.body.classList.remove('bg-gray-900', 'text-white');
  });

  document.getElementById('fontSizeSlider').addEventListener('input', (e) => {
    document.body.style.fontSize = `${e.target.value}px`;
  });

  document.getElementById('checkerFileInput').addEventListener('change', () => {
    const file = document.getElementById('checkerFileInput').files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const parsed = parseChromeBookmarks(String(evt.target.result || ''));
      if (parsed.length === 0) {
        alert('检测工作台未解析到数据');
        return;
      }
      checkState.rows = parsed.map((b, idx) => ({
        id: `temp_${idx}_${generateId()}`,
        index: idx + 1,
        folder: b.originalPath || b.category || '未分类',
        category: b.category || '未分类',
        title: b.title,
        url: b.url,
        normalizedUrl: normalizeUrl(b.url),
        duplicateKey: normalizeDuplicateUrl(b.url),
        selected: false,
        attempts: [],
        finalStatus: 'unchecked',
        latencyMs: null,
        reason: '',
        sourceType: 'workspace',
        sourceBookmarkId: null,
        isDuplicate: false,
        duplicateGroup: null
      }));
      rebuildRowMap();
      recomputeDuplicates();
      renderCheckTree();
      renderCheckResults();
      updateCheckStats();
      renderPreview(null);
      alert(`检测工作台已加载 ${checkState.rows.length} 条记录`);
    };
    reader.readAsText(file);
  });

  document.getElementById('checkFirstBtn').addEventListener('click', () => runCheck('all'));
  document.getElementById('checkRetryBtn').addEventListener('click', () => runCheck('failed'));
  document.getElementById('checkInvalidRetryBtn').addEventListener('click', () => runCheck('invalidOnly'));
  document.getElementById('checkStopBtn').addEventListener('click', stopCheck);
  document.getElementById('deleteInvalidBtn').addEventListener('click', deleteInvalidLinks);
  document.getElementById('openDuplicatesBtn').addEventListener('click', openDuplicatesModal);
  document.getElementById('exportCheckedBtn').addEventListener('click', exportCheckedBookmarks);
  document.getElementById('resultFilter').addEventListener('change', (e) => {
    checkState.selectedFilter = e.target.value;
    renderCheckResults();
  });

  const bookmarkGrid = document.getElementById('bookmarkGrid');
  if (bookmarkGrid) {
    bookmarkGrid.addEventListener('dragstart', (e) => {
      const card = e.target && e.target.closest ? e.target.closest('.bookmark-card[data-bookmark-id]') : null;
      if (!card) return;
      bookmarkDragState.draggingId = card.dataset.bookmarkId;
      card.classList.add('opacity-60');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', bookmarkDragState.draggingId || '');
      }
    });

    bookmarkGrid.addEventListener('dragend', () => {
      bookmarkDragState.draggingId = null;
      document.querySelectorAll('.bookmark-card.opacity-60').forEach((el) => el.classList.remove('opacity-60'));
      document.querySelectorAll('.bookmark-card.ring-2').forEach((el) => el.classList.remove('ring-2', 'ring-primary'));
      document.querySelectorAll('.category-drop-zone.bg-blue-100').forEach((el) => el.classList.remove('bg-blue-100'));
      document.querySelectorAll('.category-sort-item.ring-2').forEach((el) => el.classList.remove('ring-2', 'ring-primary'));
    });

    bookmarkGrid.addEventListener('dragover', (e) => {
      if (!bookmarkDragState.draggingId) return;
      const card = e.target && e.target.closest ? e.target.closest('.bookmark-card[data-bookmark-id]') : null;
      if (!card) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.bookmark-card.ring-2').forEach((el) => el.classList.remove('ring-2', 'ring-primary'));
      if (card.dataset.bookmarkId !== bookmarkDragState.draggingId) card.classList.add('ring-2', 'ring-primary');
    });

    bookmarkGrid.addEventListener('drop', (e) => {
      const draggingId = bookmarkDragState.draggingId;
      if (!draggingId) return;
      const card = e.target && e.target.closest ? e.target.closest('.bookmark-card[data-bookmark-id]') : null;
      if (!card) return;
      e.preventDefault();
      const targetId = card.dataset.bookmarkId;
      const changed = moveBookmarkBefore(draggingId, targetId);
      if (changed) persistAfterBookmarkLayoutChange();
    });
  }

  const categoryList = document.getElementById('categoryList');
  if (categoryList) {
    categoryList.addEventListener('dragstart', (e) => {
      const item = e.target && e.target.closest ? e.target.closest('.category-sort-item[data-category-id]') : null;
      if (!item) return;
      categoryDragState.draggingId = item.dataset.categoryId;
      item.classList.add('opacity-60');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', categoryDragState.draggingId || '');
      }
    });

    categoryList.addEventListener('dragend', () => {
      categoryDragState.draggingId = null;
      document.querySelectorAll('.category-sort-item.opacity-60').forEach((el) => el.classList.remove('opacity-60'));
      document.querySelectorAll('.category-sort-item.ring-2').forEach((el) => el.classList.remove('ring-2', 'ring-primary'));
      document.querySelectorAll('.category-drop-zone.bg-blue-100').forEach((el) => el.classList.remove('bg-blue-100'));
    });

    categoryList.addEventListener('dragover', (e) => {
      if (categoryDragState.draggingId) {
        const item = e.target && e.target.closest ? e.target.closest('.category-sort-item[data-category-id]') : null;
        if (!item) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        document.querySelectorAll('.category-sort-item.ring-2').forEach((el) => el.classList.remove('ring-2', 'ring-primary'));
        if (item.dataset.categoryId !== categoryDragState.draggingId) item.classList.add('ring-2', 'ring-primary');
        return;
      }
      if (!bookmarkDragState.draggingId) return;
      const zone = e.target && e.target.closest ? e.target.closest('[data-drop-category]') : null;
      if (!zone) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });

    categoryList.addEventListener('dragenter', (e) => {
      if (!bookmarkDragState.draggingId) return;
      const zone = e.target && e.target.closest ? e.target.closest('[data-drop-category]') : null;
      if (!zone) return;
      zone.classList.add('bg-blue-100');
    });

    categoryList.addEventListener('dragleave', (e) => {
      const zone = e.target && e.target.closest ? e.target.closest('[data-drop-category]') : null;
      if (!zone) return;
      zone.classList.remove('bg-blue-100');
    });

    categoryList.addEventListener('drop', (e) => {
      if (categoryDragState.draggingId) {
        const targetItem = e.target && e.target.closest ? e.target.closest('.category-sort-item[data-category-id]') : null;
        if (!targetItem) return;
        e.preventDefault();
        const changed = reorderCategorySiblings(categoryDragState.draggingId, targetItem.dataset.categoryId);
        if (changed) {
          saveCategories();
          renderCategories();
        }
        document.querySelectorAll('.category-sort-item.ring-2').forEach((el) => el.classList.remove('ring-2', 'ring-primary'));
        return;
      }
      const draggingId = bookmarkDragState.draggingId;
      if (!draggingId) return;
      const zone = e.target && e.target.closest ? e.target.closest('[data-drop-category]') : null;
      if (!zone) return;
      e.preventDefault();
      const nextCategory = zone.dataset.dropCategory || '';
      const changed = moveBookmarkToCategory(draggingId, nextCategory);
      if (changed) persistAfterBookmarkLayoutChange();
      zone.classList.remove('bg-blue-100');
    });
  }

  const checkResultsBody = document.getElementById('checkResultsBody');
  if (checkResultsBody) {
    checkResultsBody.addEventListener('change', (e) => {
      const target = e.target;
      if (!target || !target.classList || !target.classList.contains('row-selector')) return;
      const row = checkState.rowMap.get(target.dataset.id);
      if (row) row.selected = target.checked;
    });

    checkResultsBody.addEventListener('click', (e) => {
      if (e.target && e.target.closest('input')) return;
      const tr = e.target && e.target.closest ? e.target.closest('tr[data-row-id]') : null;
      if (!tr) return;
      const row = checkState.rowMap.get(tr.dataset.rowId);
      if (!row) return;
      checkState.selectedPreviewId = row.id;
      renderPreview(row);
    });
  }
  document.getElementById('removeSelectedDuplicatesBtn').addEventListener('click', removeSelectedDuplicates);
  document.getElementById('keepDuplicatesBtn').addEventListener('click', () => closeModal('duplicatesModal'));
}

init();
