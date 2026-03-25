// 修复Chrome书签导入问题的简化解析函数
function parseChromeBookmarksSimple(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    const parsedBookmarks = [];
    
    // 简单的解析方法：直接查找所有的<a>标签
    const linkElements = doc.querySelectorAll('a');
    
    linkElements.forEach(link => {
        const title = link.textContent.trim();
        const url = link.getAttribute('href');
        
        if (title && url && url.startsWith('http')) {
            // 提取favicon
            let favicon = '';
            try {
                const domain = new URL(url).hostname;
                favicon = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
            } catch (e) {
                favicon = '';
            }
            
            // 获取原始路径（从父级H3标签获取）
            let originalPath = '';
            let parent = link.parentElement;
            while (parent) {
                if (parent.tagName === 'H3') {
                    originalPath = parent.textContent.trim();
                    break;
                }
                parent = parent.parentElement;
            }
            
            parsedBookmarks.push({
                id: Date.now().toString(36) + Math.random().toString(36).substr(2),
                title,
                url,
                category: '未分类',
                favicon,
                originalPath: originalPath || '书签栏',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
        }
    });
    
    return parsedBookmarks;
}