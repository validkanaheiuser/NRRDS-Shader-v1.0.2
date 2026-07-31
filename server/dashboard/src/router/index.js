import { createRouter, createWebHashHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth.js';

const routes = [
  { path: '/login', component: () => import('@/views/LoginView.vue'), meta: { public: true } },
  { path: '/',      component: () => import('@/views/MainView.vue') },
  { path: '/admin', component: () => import('@/views/AdminView.vue'), meta: { admin: true } },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({ history: createWebHashHistory(), routes });

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.ready) await auth.init();

  if (!to.meta.public && !auth.user) return '/login';
  if (to.meta.admin && auth.user?.role !== 'admin') return '/';
  if (to.path === '/login' && auth.user) return '/';
});

export default router;
