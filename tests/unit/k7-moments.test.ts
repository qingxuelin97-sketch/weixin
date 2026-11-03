/**
 * 朋友圈发表页的「＋从相册添加」(M-K7)。
 *
 * 守的是接线，不是像素：「＋」格必须真的打开一个 image 选择器，选中的照片必须走素材库
 * 导入（putMedia + registerMedia，与聊天发图同一条管线），并且上限是 MAX_IMAGES。
 * 写了没接线 = 没做——一个不导入的加号只会让人白点一下。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 这是「必须包含」型守卫，所以**不剥注释**：剥注释只会让守卫更弱（注释里的字串也能
// 冒充代码），而不会造成误报。注意 accept="image/*" 里的 /* 会被注释正则当成块注释的
// 开头，把中间的代码整段吃掉——这正是不剥的理由。
const src = readFileSync(resolve(__dirname, '../../src/features/moments/MomentPublishPage.tsx'), 'utf8');

describe('发表页：从相册添加', () => {
  it('解析器没有失明：认出了选图网格', () => {
    expect(src).toContain('publish__picker');
  });
  it('「＋」格打开一个 image 选择器', () => {
    expect(src).toContain('publish__thumb--add');
    expect(src).toMatch(/accept="image\/\*"/);
    expect(src).toMatch(/albumRef\.current\?\.click\(\)/);
  });
  it('导入走素材库（putMedia + registerMedia），标签是「朋友圈」', () => {
    expect(src).toContain('repo.putMedia(item)');
    expect(src).toContain('registerMedia(item.id');
    expect(src).toContain("tags: ['朋友圈']");
  });
  it('选上的照片受 MAX_IMAGES 上限约束', () => {
    expect(src).toMatch(/cur\.length >= MAX_IMAGES \? cur/);
  });
});
