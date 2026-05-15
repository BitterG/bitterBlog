import { defineCollection, z } from 'astro:content';

const postsCollection = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    date: z.string(),
    updated: z.string(),
    category: z.string(),
    tags: z.array(z.string()).default([]),
  }),
});

export const collections = {
  posts: postsCollection,
};
