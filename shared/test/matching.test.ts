import { describe, expect, it } from 'vitest';
import { artistTokens, maskTitle, matchGuess, normalizeTitle, stripEditionTags, titlesMatch } from '../src/matching';

const eileen = {
  id: 'target',
  title: 'Come On Eileen (Single Edit)',
  artists: ['Dexys Midnight Runners & Kevin Rowland'],
  isrc: 'GBAAA8200001',
};

describe('normalizeTitle', () => {
  it('strips edition tags', () => {
    expect(normalizeTitle('Come On Eileen (Single Edit)')).toBe('come on eileen');
    expect(normalizeTitle('Bohemian Rhapsody - Remastered 2011')).toBe('bohemian rhapsody');
    expect(normalizeTitle('Smells Like Teen Spirit [2021 Remaster]')).toBe('smells like teen spirit');
    expect(normalizeTitle('Crazy In Love (feat. Jay-Z)')).toBe('crazy in love');
    expect(normalizeTitle('Uptown Funk feat. Bruno Mars')).toBe('uptown funk');
    expect(normalizeTitle('Livin’ on a Prayer')).toBe('livin on a prayer');
  });

  it('keeps meaningful parentheses', () => {
    expect(normalizeTitle("Don't You (Forget About Me)")).toBe('dont you forget about me');
    expect(normalizeTitle("(I Can't Get No) Satisfaction")).toBe('i cant get no satisfaction');
  });

  it('strips diacritics and handles non-Latin scripts', () => {
    expect(normalizeTitle('Şımarık')).toBe('simarik');
    expect(normalizeTitle('Dernière danse')).toBe('derniere danse');
    expect(normalizeTitle('תל אביב')).toBe('תל אביב');
  });
});

describe('artistTokens', () => {
  it('splits multi-artist credits', () => {
    const t = artistTokens(['Dexys Midnight Runners & Kevin Rowland']);
    expect(t.has('dexys midnight runners')).toBe(true);
    expect(t.has('kevin rowland')).toBe(true);
  });

  it('drops a leading "the"', () => {
    expect(artistTokens(['The Beatles']).has('beatles')).toBe(true);
  });

  it('does not split names that merely end in x', () => {
    expect(artistTokens(['Lil Nas X']).has('lil nas x')).toBe(true);
  });
});

describe('matchGuess', () => {
  it('rejects a cover by a different artist (spec case 1)', () => {
    const guess = { id: 'g1', title: 'Come On Eileen', artists: ["Pickin' On Series"] };
    expect(matchGuess(eileen, guess)).toEqual({ correct: false, reason: 'none' });
  });

  it('accepts another edition by the same primary artist (spec case 2)', () => {
    const guess = { id: 'g2', title: 'Come On Eileen', artists: ['Dexys Midnight Runners'] };
    expect(matchGuess(eileen, guess)).toEqual({ correct: true, reason: 'canonical' });
  });

  it('accepts exact id and ISRC matches', () => {
    expect(matchGuess(eileen, { id: 'target', title: 'x', artists: ['y'] }).reason).toBe('id');
    expect(matchGuess(eileen, { id: 'other', title: 'x', artists: ['y'], isrc: 'gbaaa8200001' }).reason).toBe('isrc');
  });

  it('rejects a different song by the same artist', () => {
    const guess = { id: 'g3', title: 'Geno', artists: ['Dexys Midnight Runners'] };
    expect(matchGuess(eileen, guess).correct).toBe(false);
  });

  it('tolerates small spelling variants in longer titles', () => {
    const target = { id: 't', title: "Livin' On A Prayer", artists: ['Bon Jovi'] };
    expect(matchGuess(target, { id: 'g', title: 'Living On A Prayer', artists: ['Bon Jovi'] }).correct).toBe(true);
  });

  it('does not fuzz short titles', () => {
    const target = { id: 't', title: 'Jump', artists: ['Van Halen'] };
    expect(matchGuess(target, { id: 'g', title: 'Hump', artists: ['Van Halen'] }).correct).toBe(false);
  });

  it('matches duo credits written differently', () => {
    const target = { id: 't', title: 'You Make My Dreams', artists: ['Daryl Hall & John Oates'] };
    expect(matchGuess(target, { id: 'g', title: 'You Make My Dreams (Come True)', artists: ['Hall & Oates'] }).correct).toBe(true);
  });

  it('matches featured artists in either direction', () => {
    const target = { id: 't', title: 'Uptown Funk (feat. Bruno Mars)', artists: ['Mark Ronson'] };
    expect(matchGuess(target, { id: 'g', title: 'Uptown Funk', artists: ['Mark Ronson', 'Bruno Mars'] }).correct).toBe(true);
  });
});

describe('maskTitle', () => {
  it('keeps first letters and masks the rest', () => {
    expect(maskTitle('Come On Eileen (Single Edit)')).toBe('C••• O• E•••••');
    expect(maskTitle("Don't Stop Believin'")).toBe("D••'• S••• B•••••••'");
  });

  it('strips edition tags first', () => {
    expect(stripEditionTags('Bohemian Rhapsody - Remastered 2011')).toBe('Bohemian Rhapsody');
  });

  it('never treats titles with different numbers as the same song', () => {
    expect(titlesMatch('Liked Song 7', 'Liked Song 3')).toBe(false);
    expect(titlesMatch('Symphony No. 5', 'Symphony No. 9')).toBe(false);
    expect(titlesMatch('22', '23')).toBe(false);
    expect(titlesMatch("Livin' on a Prayer", 'Living on a Prayer')).toBe(true);
  });
});
