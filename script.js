/* ================================================================
   SAMPLE ARTICLE DATA
   ================================================================ */

const articles = [
  {
    id: 1,
    title: "深入理解 JavaScript 事件循环.",
    excerpt: "从调用栈到任务队列，系统地理解 JS 的事件循环机制，掌握宏任务与微任务的执行顺序。",
    date: "2026-05-12",
    tags: ["JavaScript", "前端"],
    author: "kugua",
    category: "frontend"
  },
  {
    id: 2,
    title: "Rust 所有权模型实战指南.",
    excerpt: "通过实际代码示例理解 Rust 的所有权、借用与生命周期，写出更安全的高性能代码。",
    date: "2026-05-08",
    tags: ["Rust", "系统编程"],
    author: "kugua",
    category: "backend"
  },
  {
    id: 3,
    title: "设计模式在前端工程中的实践.",
    excerpt: "观察者模式、策略模式、工厂模式在前端项目中的实际应用场景与代码实现。",
    date: "2026-05-03",
    tags: ["设计模式", "前端", "架构"],
    author: "kugua",
    category: "architecture"
  },
  {
    id: 4,
    title: "使用 Docker 构建开发环境.",
    excerpt: "告别环境配置地狱，使用 Docker 和 Docker Compose 快速搭建一致的本地开发环境。",
    date: "2026-04-28",
    tags: ["Docker", "DevOps"],
    author: "kugua",
    category: "devops"
  },
  {
    id: 5,
    title: "CSS Grid 布局完全指南.",
    excerpt: "从基础概念到高级技巧，全面掌握 CSS Grid 布局系统，构建复杂的响应式页面。",
    date: "2026-04-22",
    tags: ["CSS", "前端"],
    author: "kugua",
    category: "frontend"
  },
  {
    id: 6,
    title: "Node.js Stream 处理大文件.",
    excerpt: "使用 Node.js Stream API 高效地读取、转换和写入大文件，避免内存溢出问题。",
    date: "2026-04-18",
    tags: ["Node.js", "后端"],
    author: "kugua",
    category: "backend"
  },
  {
    id: 7,
    title: "TypeScript 高级类型技巧.",
    excerpt: "条件类型、模板字面量类型、映射类型等 TypeScript 高级类型的实用技巧。",
    date: "2026-04-12",
    tags: ["TypeScript", "前端"],
    author: "kugua",
    category: "frontend"
  },
  {
    id: 8,
    title: "Web 性能优化实战指南.",
    excerpt: "从资源加载到渲染优化，全面了解 Web 性能优化的核心指标和实用策略。",
    date: "2026-04-05",
    tags: ["性能优化", "前端"],
    author: "kugua",
    category: "frontend"
  },
  {
    id: 9,
    title: "微服务架构中的服务间通信.",
    excerpt: "比较 REST、gRPC 和消息队列在微服务架构中的适用场景及选型建议。",
    date: "2026-03-28",
    tags: ["微服务", "架构", "后端"],
    author: "kugua",
    category: "architecture"
  },
  {
    id: 10,
    title: "React 状态管理方案对比.",
    excerpt: "从 useState 到 Zustand，对比分析不同 React 状态管理方案的优劣和适用场景。",
    date: "2026-03-20",
    tags: ["React", "前端", "状态管理"],
    author: "kugua",
    category: "frontend"
  },
  {
    id: 11,
    title: "SQL 查询优化实用技巧.",
    excerpt: "索引优化、查询改写和执行计划分析，提升数据库查询性能的实用方法。",
    date: "2026-03-15",
    tags: ["SQL", "数据库", "后端"],
    author: "kugua",
    category: "backend"
  },
  {
    id: 12,
    title: "Git 工作流最佳实践.",
    excerpt: "从分支策略到 commit 规范，打造高效的团队 Git 协作流程。",
    date: "2026-03-08",
    tags: ["Git", "DevOps"],
    author: "kugua",
    category: "devops"
  }
];

/* ================================================================
   STATE
   ================================================================ */

const PAGE_SIZE = 6;
let currentPage = 1;
let currentQuery = '';
let filteredArticles = [...articles];

/* ================================================================
   DOM REFERENCES
   ================================================================ */

const articlesGrid = document.getElementById('articlesGrid');
const articlesEmpty = document.getElementById('articlesEmpty');
const articlesFooter = document.getElementById('articlesFooter');
const loadMoreBtn = document.getElementById('loadMoreBtn');
const searchInput = document.getElementById('searchInput');
const articleCount = document.getElementById('articleCount');
const hamburgerBtn = document.getElementById('hamburgerBtn');
const mobileMenu = document.getElementById('mobileMenu');

/* ================================================================
   RENDER
   ================================================================ */

function createArticleCard(article) {
  const card = document.createElement('article');
  card.className = 'article-card';

  // Hero image placeholder
  const colors = ['#f5f5f5', '#fafafa', '#f0f0f0'];
  const bgColor = colors[article.id % colors.length];

  card.innerHTML = `
    <div class="article-card-image" style="background: linear-gradient(135deg, ${bgColor}, ${bgColor} 50%, #eaeaea 100%);">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="16" y1="13" x2="8" y2="13"/>
        <line x1="16" y1="17" x2="8" y2="17"/>
        <line x1="10" y1="9" x2="8" y2="9"/>
      </svg>
    </div>
    <div class="article-card-body">
      <div class="article-card-tags">
        ${article.tags.map(tag => `<span class="article-card-tag">${tag}</span>`).join('')}
      </div>
      <h3 class="article-card-title display-sm">${article.title}</h3>
      <p class="article-card-excerpt body-sm">${article.excerpt}</p>
      <div class="article-card-meta">
        <span class="article-card-date">${article.date}</span>
        <span class="article-card-author">${article.author}</span>
      </div>
    </div>
  `;

  return card;
}

function renderArticles() {
  const visible = filteredArticles.slice(0, currentPage * PAGE_SIZE);
  const hasMore = visible.length < filteredArticles.length;

  articlesGrid.innerHTML = '';
  articlesEmpty.style.display = 'none';

  if (filteredArticles.length === 0) {
    articlesEmpty.style.display = 'block';
    articlesFooter.style.display = 'none';
    articleCount.textContent = '0';
    return;
  }

  visible.forEach(article => {
    articlesGrid.appendChild(createArticleCard(article));
  });

  articleCount.textContent = filteredArticles.length;
  articlesFooter.style.display = hasMore ? 'flex' : 'none';
}

/* ================================================================
   SEARCH
   ================================================================ */

function filterArticles(query) {
  const q = query.toLowerCase().trim();

  if (!q) {
    filteredArticles = [...articles];
    return;
  }

  filteredArticles = articles.filter(a =>
    a.title.toLowerCase().includes(q) ||
    a.excerpt.toLowerCase().includes(q) ||
    a.tags.some(t => t.toLowerCase().includes(q)) ||
    a.category.toLowerCase().includes(q)
  );
}

searchInput.addEventListener('input', function () {
  currentQuery = this.value;
  currentPage = 1;
  filterArticles(currentQuery);
  renderArticles();
});

/* ================================================================
   LOAD MORE
   ================================================================ */

loadMoreBtn.addEventListener('click', function () {
  currentPage++;
  const visible = filteredArticles.slice(0, currentPage * PAGE_SIZE);
  const hasMore = visible.length < filteredArticles.length;

  // Append only new cards
  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const newArticles = filteredArticles.slice(startIdx, startIdx + PAGE_SIZE);

  newArticles.forEach(article => {
    articlesGrid.appendChild(createArticleCard(article));
  });

  articlesFooter.style.display = hasMore ? 'flex' : 'none';
});

/* ================================================================
   MOBILE MENU
   ================================================================ */

function openMobileMenu() {
  mobileMenu.classList.add('open');
  hamburgerBtn.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeMobileMenu() {
  mobileMenu.classList.remove('open');
  hamburgerBtn.classList.remove('open');
  document.body.style.overflow = '';
}

hamburgerBtn.addEventListener('click', function () {
  if (mobileMenu.classList.contains('open')) {
    closeMobileMenu();
  } else {
    openMobileMenu();
  }
});

// Close menu when clicking a mobile nav link
mobileMenu.querySelectorAll('.mobile-nav-link').forEach(link => {
  link.addEventListener('click', closeMobileMenu);
});

/* ================================================================
   INIT
   ================================================================ */

renderArticles();
