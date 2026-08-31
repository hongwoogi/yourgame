// Synthetic browser-test content, never a production scenario or release artifact.
export function fixtureBundle({ version = 'fixture-v1', health = 6 } = {}) {
  const words = (en, ko) => ({ en, ko });
  return {
    schemaVersion: 1,
    config: {
      schemaVersion: 1, gameVersion: version, handSize: 2,
      heroes: [{ id: 'hero-a', stats: { health, food: 3, gold: 3, morale: 3 }, deck: ['guard', 'harvest'] }],
      cards: [
        { id: 'guard', cost: { food: 0, gold: 1, morale: 0 }, effect: { health: 0, food: 0, gold: 0, morale: 0, defense: 6 } },
        { id: 'harvest', cost: { food: 0, gold: 0, morale: 0 }, effect: { health: 0, food: 2, gold: 1, morale: 0, defense: 0 } },
      ],
      enemies: [{ id: 'enemy-a', strength: 4 }],
      waves: [
        { enemies: ['enemy-a'], foodCost: 1, reward: { food: 0, gold: 1, morale: 1 } },
        { enemies: ['enemy-a'], foodCost: 1, reward: { food: 0, gold: 1, morale: 1 } },
      ],
    },
    copy: {
      title: words('Fixture Kingdom', '테스트 왕국'),
      subtitle: words('A synthetic two-wave test.', '두 공세로 구성된 합성 테스트입니다.'),
      story: words('Choose a card and defend a test kingdom.', '카드를 골라 테스트 왕국을 지키세요.'),
      victory: words('Fixture victory recorded.', '테스트 승리가 기록됐습니다.'),
      defeat: words('Fixture defeat recorded.', '테스트 패배가 기록됐습니다.'),
      disclaimer: words('Synthetic test content. Not a released game.', '공개 게임이 아닌 합성 테스트 콘텐츠입니다.'),
      heroes: [{ id: 'hero-a', name: words('Fixture Founder', '테스트 창립자'), role: words('Defender', '방어자'),
        description: words('A deterministic test hero.', '결정적 테스트 영웅입니다.') }],
      cards: [
        { id: 'guard', name: words('Fixture Guard', '테스트 방어'), description: words('Add six defense to one hex.', '타일 하나에 방어 6을 추가합니다.') },
        { id: 'harvest', name: words('Fixture Harvest', '테스트 수확'), description: words('Gain two food and one gold.', '식량 2와 금화 1을 얻습니다.') },
      ],
      enemies: [{ id: 'enemy-a', name: words('Fixture Attacker', '테스트 공격자') }],
      waves: [
        { title: words('Fixture wave one', '테스트 첫 공세'), description: words('One test attacker approaches.', '테스트 공격자 하나가 다가옵니다.') },
        { title: words('Fixture wave two', '테스트 둘째 공세'), description: words('The final test attacker approaches.', '마지막 테스트 공격자가 다가옵니다.') },
      ],
    },
    art: { background: '#f6f1e5', panel: '#fffaf0', accent: '#6b7545', ink: '#23352b', muted: '#667064', heroIcons: [{ id: 'hero-a', icon: 'crown' }] },
  };
}
