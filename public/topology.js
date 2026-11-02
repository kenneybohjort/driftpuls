// Gemensam switch- och topologimodul för Driftpuls (delas av server.js och public/admin.js)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const api = factory();
    Object.assign(root, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CUSTOMERS_PER_ACC = 24;
  const ACC_PER_DIST = 24;
  const MAX_CUSTOMERS_PER_DIST = ACC_PER_DIST * CUSTOMERS_PER_ACC; // 576

  // Identifiera enhetsroll utifrån namnsättning, t.ex. "arbra_acc_04", "arbra_dist_01", "bol-c-nod02-ups1"
  function parseDeviceRole(device = '') {
    const s = String(device || '').trim();
    const distMatch = s.match(/^([a-z0-9åäö_-]+?)[_-]dist(?:[_-]?(\d+))?$/i);
    if (distMatch) {
      return {
        prefix: distMatch[1].toLowerCase(),
        role: 'dist',
        num: distMatch[2] ? parseInt(distMatch[2], 10) : null,
        rawNum: distMatch[2] || '',
        raw: s,
      };
    }
    const accMatch = s.match(/^([a-z0-9åäö_-]+?)[_-]acc(?:[_-]?(\d+))?$/i);
    if (accMatch) {
      return {
        prefix: accMatch[1].toLowerCase(),
        role: 'acc',
        num: accMatch[2] ? parseInt(accMatch[2], 10) : null,
        rawNum: accMatch[2] || '',
        raw: s,
      };
    }
    if (/ups|batteri|battery|rectifier|likriktare/i.test(s)) {
      return { prefix: s.toLowerCase(), role: 'ups', num: null, rawNum: '', raw: s };
    }
    return { prefix: s.toLowerCase(), role: 'other', num: null, rawNum: '', raw: s };
  }

  // Komprimera enhetslista för adminvy/NIS2, t.ex. ["arbra_acc_03", ..., "arbra_acc_12"] -> "arbra_acc_03–12 (10 st)"
  function summarizeDevices(devices = []) {
    const list = [...new Set((devices || []).map((d) => String(d || '').trim()).filter(Boolean))];
    if (list.length === 0) return '';
    if (list.length === 1) return list[0];

    const parsed = list.map(parseDeviceRole);
    const groups = new Map();
    for (const p of parsed) {
      const gKey = p.role === 'acc' || p.role === 'dist' ? `${p.prefix}_${p.role}` : `other:${p.raw}`;
      if (!groups.has(gKey)) groups.set(gKey, []);
      groups.get(gKey).push(p);
    }

    const parts = [];
    for (const [, items] of groups) {
      if (items.length === 1) {
        parts.push(items[0].raw);
        continue;
      }
      const first = items[0];
      const withNums = items.filter((i) => i.num !== null).sort((a, b) => a.num - b.num);
      if (withNums.length === items.length && (first.role === 'acc' || first.role === 'dist')) {
        const minItem = withNums[0];
        const maxItem = withNums[withNums.length - 1];
        const padLen = Math.max(minItem.rawNum.length, maxItem.rawNum.length, 2);
        const minStr = String(minItem.num).padStart(padLen, '0');
        const maxStr = String(maxItem.num).padStart(padLen, '0');
        const isContiguous = (maxItem.num - minItem.num + 1) === withNums.length;
        const sep = isContiguous ? '–' : '..';
        parts.push(`${first.prefix}_${first.role}_${minStr}${sep}${maxStr} (${items.length} st)`);
      } else {
        parts.push(`${items.slice(0, 3).map((i) => i.raw).join(', ')}${items.length > 3 ? ` +${items.length - 3} till` : ''}`);
      }
    }
    return parts.join(', ');
  }

  // Beräkna publik områdesrubrik, omfattnings-badge, neutral lägesrapport och kundpåverkan (NIS2)
  function computeSwitchImpact(alertList = [], node = null) {
    const items = Array.isArray(alertList) ? alertList.filter(Boolean) : [alertList].filter(Boolean);
    const first = items[0] || {};
    const baseArea = String(node?.name || first.area || 'Okänt område')
      .replace(/\s*\(begränsat område\)\s*$/i, '')
      .replace(/^Delar av\s+/i, '')
      .trim();
    const totalCustomers = Math.max(0, parseInt(node?.customers ?? first.customers, 10) || 0);
    const distCount = Math.max(1, parseInt(node?.distCount ?? first.distCount, 10) || 1);
    const accCount = Math.max(1, parseInt(node?.accCount ?? first.accCount, 10) || 24);

    const roles = items.map((a) => parseDeviceRole(a.device || ''));
    const downDist = roles.filter((r) => r.role === 'dist').length;
    const downAcc = roles.filter((r) => r.role === 'acc').length;

    let publicArea = baseArea;
    let scope = '';
    let techDetails = `Driftstörning i ${baseArea}. Felsökning pågår.`;
    let fraction = 1;
    let summaryLabel = '';
    let estimatedCustomers = totalCustomers;

    if (downDist >= distCount || downAcc >= accCount) {
      // Samtliga dist-switchar i fiberboden (t.ex. 1 av 1) eller alla access-switchar nere -> Hela området
      publicArea = baseArea;
      scope = 'full';
      techDetails = `Driftstörning i nod som påverkar ${baseArea}. Felsökning pågår.`;
      fraction = 1;
      summaryLabel = downDist > 0
        ? `${downDist}/${distCount} dist-switchar nere (hela noden)`
        : `${downAcc}/${accCount} access-switchar nere`;
      estimatedCustomers = totalCustomers > 0
        ? totalCustomers
        : accCount * CUSTOMERS_PER_ACC;
    } else if (downDist > 0 && downDist < distCount) {
      // 1 av flera dist-switchar i större fiberbod nere -> Större delområde (max 24*24 = 576 kunder per dist-switch)
      publicArea = `Delar av ${baseArea}`;
      scope = 'major';
      techDetails = `Driftstörning i nod som påverkar delar av ${baseArea}. Felsökning pågår.`;
      fraction = Math.max(downDist / distCount, downAcc / accCount);
      summaryLabel = `${downDist} av ${distCount} dist-switchar nere${downAcc ? ` (+${downAcc} acc)` : ''}`;
      const maxByDistPorts = downDist * MAX_CUSTOMERS_PER_DIST;
      estimatedCustomers = totalCustomers > 0
        ? Math.min(totalCustomers, maxByDistPorts, Math.max(1, Math.round(totalCustomers * fraction)))
        : Math.min(accCount * CUSTOMERS_PER_ACC, maxByDistPorts);
    } else if (downAcc > 1) {
      // Flera access-switchar nere i samma nod (t.ex. arbra_acc_03..12) -> Flera delområden (max 24 kunder per acc-switch)
      publicArea = `Delar av ${baseArea}`;
      scope = 'partial';
      techDetails = `Driftstörning som påverkar delar av ${baseArea}. Felsökning pågår.`;
      fraction = Math.min(1, downAcc / accCount);
      summaryLabel = `${downAcc} av ${accCount} access-switchar nere`;
      const maxByAccPorts = downAcc * CUSTOMERS_PER_ACC;
      estimatedCustomers = totalCustomers > 0
        ? Math.min(totalCustomers, maxByAccPorts, Math.max(1, Math.round(totalCustomers * fraction)))
        : maxByAccPorts;
    } else if (downAcc === 1) {
      // En enskild access-switch nere (t.ex. arbra_acc_04) -> Begränsat delområde (max 24 kunder)
      publicArea = `${baseArea} (begränsat område)`;
      scope = 'limited';
      techDetails = `Driftstörning som berör ett begränsat antal fastigheter i ${baseArea}. Felsökning pågår.`;
      fraction = Math.min(1, 1 / accCount);
      summaryLabel = `1 access-switch nere (1/${accCount})`;
      estimatedCustomers = totalCustomers > 0
        ? Math.min(totalCustomers, CUSTOMERS_PER_ACC, Math.max(1, Math.round(totalCustomers * fraction)))
        : CUSTOMERS_PER_ACC;
    } else if (roles.some((r) => r.role === 'ups')) {
      publicArea = baseArea;
      scope = 'full';
      techDetails = `Strömavbrott påverkar utrustning i ${baseArea}. Felsökning pågår.`;
      fraction = 1;
      summaryLabel = 'UPS / Kraftmatning';
      estimatedCustomers = totalCustomers > 0 ? totalCustomers : 0;
    } else {
      estimatedCustomers = totalCustomers > 0
        ? Math.max(1, Math.round(totalCustomers * fraction))
        : 0;
    }

    return {
      baseArea,
      publicArea,
      scope,
      techDetails,
      estimatedCustomers,
      totalCustomers,
      fraction,
      downDist,
      downAcc,
      distCount,
      accCount,
      summaryLabel,
    };
  }

  return {
    CUSTOMERS_PER_ACC,
    ACC_PER_DIST,
    MAX_CUSTOMERS_PER_DIST,
    parseDeviceRole,
    summarizeDevices,
    computeSwitchImpact,
  };
});
