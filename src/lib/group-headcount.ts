/**
 * 群人数 (M-K8)：微信在群聊页标题「群名(5)」与聊天信息页标题「聊天信息(5)」里显示的
 * 那个数——**成员加上你自己**。
 *
 * 只数还在的人：memberIds 里可能残留已删除联系人的 id（删除级联对群成员表做的是
 * 逐条手术，但老数据不保证），数它们就会出现「(5)」里只画得出四个头像。
 *
 * 此前这个数被写死在种子群的**名字**里，见 appStore 的 fixLegacySeedTitles。
 */
export function groupHeadcount(
  memberIds: readonly string[] | undefined,
  exists: (id: string) => boolean,
): number {
  return (memberIds ?? []).filter(exists).length + 1;
}
