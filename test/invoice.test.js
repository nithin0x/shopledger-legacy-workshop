var test = require('node:test');
var assert = require('node:assert/strict');
var invoice = require('../lib/invoice');
var pricing = require('../lib/pricing');
var coupons = require('../lib/coupons');
var reports = require('../lib/reports');

// Run with node --test. All orders are synthetic in-memory fixtures.
// Do not import server.js, routes, or store.js: these tests need no datastore.
// CURRENT BEHAVIOUR assertions describe remaining quirks, not desired fixes.
function item(overrides) {
  return Object.assign({
    id: 1,
    sku: 'TEST-1',
    name: 'Synthetic item',
    hsn: '0902',
    price: 100,
    qty: 1
  }, overrides);
}

function billedOrder(items, coupon) {
  var totals = pricing.computeTotals(items, coupon || '');
  // Matches the stored order shape; expected assertions below use literal figures.
  return {
    id: 1,
    date: '26/11/2026',
    customer: 'Synthetic customer',
    paymentMode: 'cash',
    status: 'completed',
    items: items,
    coupon: coupon || '',
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total
  };
}

function figures(totals) {
  return {
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    cgst: totals.cgst,
    sgst: totals.sgst,
    total: totals.total
  };
}

test('invoice calculation returns zero figures and no rows for an empty order', function () {
  assert.deepEqual(invoice.computeInvoiceFigures({}), {
    subtotal: 0,
    discount: 0,
    tax: 0,
    cgst: 0,
    sgst: 0,
    total: 0,
    rows: []
  });
});

test('invoice and billing agree on an unknown HSN with no coupon', function () {
  var order = billedOrder([item({ hsn: 'UNKNOWN', qty: 2 })]);
  assert.equal(order.tax, 36);
  assert.equal(order.total, 236);
  assert.deepEqual(figures(invoice.computeInvoiceFigures(order)), {
    subtotal: 200, discount: 0, tax: 36, cgst: 18, sgst: 18, total: 236
  });
});

test('invoice and billing agree on explicit percentage GST rates without a coupon', function () {
  var items = [
    item({ id: 1, gstRate: 5 }),
    item({ id: 2, gstRate: 12 }),
    item({ id: 3, gstRate: 18 })
  ];
  var order = billedOrder(items);
  var calculated = invoice.computeInvoiceFigures(order);
  assert.equal(order.tax, 35);
  assert.equal(order.total, 335);
  assert.deepEqual(figures(calculated), {
    subtotal: 300, discount: 0, tax: 35, cgst: 17.5, sgst: 17.5, total: 335
  });
  assert.deepEqual(calculated.rows.map(function (row) {
    return [row.gstPercent, row.lineTax];
  }), [[5, 5], [12, 12], [18, 18]]);
});

test('invoice uses mixed HSN slabs consistently with billing', function () {
  var order = billedOrder([
    item({ id: 1, hsn: '1006' }),
    item({ id: 2, hsn: '0405' }),
    item({ id: 3, hsn: '0902' })
  ]);
  var calculated = invoice.computeInvoiceFigures(order);
  assert.equal(order.tax, 35);
  assert.equal(order.total, 335);
  assert.deepEqual(figures(calculated), {
    subtotal: 300, discount: 0, tax: 35, cgst: 17.5, sgst: 17.5, total: 335
  });
  assert.deepEqual(calculated.rows.map(function (row) {
    return [row.hsn, row.gstPercent, row.lineTax];
  }), [['1006', 5, 5], ['0405', 12, 12], ['0902', 18, 18]]);
});

test('invoice honors an explicit zero GST rate', function () {
  var order = billedOrder([item({ gstRate: 0 })]);
  var calculated = invoice.computeInvoiceFigures(order);
  assert.equal(order.tax, 0);
  assert.equal(order.total, 100);
  assert.equal(calculated.rows[0].gstPercent, 0);
  assert.deepEqual(figures(calculated), {
    subtotal: 100, discount: 0, tax: 0, cgst: 0, sgst: 0, total: 100
  });
});

test('invoice interprets a fractional GST rate consistently with billing', function () {
  var order = billedOrder([item({ gstRate: 0.05 })]);
  var calculated = invoice.computeInvoiceFigures(order);
  assert.equal(order.tax, 5);
  assert.equal(order.total, 105);
  assert.equal(calculated.rows[0].gstPercent, 5);
  assert.equal(calculated.rows[0].lineTax, 5);
  assert.deepEqual(figures(calculated), {
    subtotal: 100, discount: 0, tax: 5, cgst: 2.5, sgst: 2.5, total: 105
  });
});

test('invoice applies SAVE10 before GST consistently with billing', function () {
  var items = [item({ price: 1000 })];
  var billed = pricing.computeTotals(items, 'SAVE10');
  assert.deepEqual(figures(billed), {
    subtotal: 1000, discount: 100, tax: 162, cgst: 81, sgst: 81, total: 1062
  });
  assert.deepEqual(figures(invoice.computeInvoiceFigures(billedOrder(items, 'SAVE10'))), {
    subtotal: 1000, discount: 100, tax: 162, cgst: 81, sgst: 81, total: 1062
  });
});

test('invoice honors the SAVE10 maximum discount cap', function () {
  var order = billedOrder([item({ price: 2000 })], 'SAVE10');
  assert.equal(order.discount, 150);
  assert.equal(order.tax, 333);
  assert.equal(order.total, 2183);
  assert.deepEqual(figures(invoice.computeInvoiceFigures(order)), {
    subtotal: 2000, discount: 150, tax: 333, cgst: 166.5, sgst: 166.5, total: 2183
  });
});

test('invoice applies FLAT50 before GST consistently with billing', function () {
  var order = billedOrder([item({ price: 1000 })], 'FLAT50');
  assert.equal(order.discount, 50);
  assert.equal(order.tax, 171);
  assert.equal(order.total, 1121);
  assert.deepEqual(figures(invoice.computeInvoiceFigures(order)), {
    subtotal: 1000, discount: 50, tax: 171, cgst: 85.5, sgst: 85.5, total: 1121
  });
});

test('invoice ignores an inactive coupon consistently with billing calculation', function () {
  // Direct invoice input characterizes a stored order carrying an inactive code;
  // the order-placement route would reject a new order using this code today.
  var order = billedOrder([item({ price: 1000 })], 'DIWALI20');
  assert.deepEqual(coupons.validate('DIWALI20', 1000), {
    valid: false, error: 'Coupon DIWALI20 has expired'
  });
  assert.equal(order.discount, 0);
  assert.equal(order.tax, 180);
  assert.equal(order.total, 1180);
  assert.deepEqual(figures(invoice.computeInvoiceFigures(order)), {
    subtotal: 1000, discount: 0, tax: 180, cgst: 90, sgst: 90, total: 1180
  });
});

test('invoice honors the FLAT50 minimum order requirement', function () {
  var order = billedOrder([item()], 'FLAT50');
  assert.deepEqual(coupons.validate('FLAT50', 100), {
    valid: false, error: 'Coupon FLAT50 requires a minimum order subtotal of ₹300'
  });
  assert.equal(order.discount, 0);
  assert.equal(order.total, 118);
  assert.deepEqual(figures(invoice.computeInvoiceFigures(order)), {
    subtotal: 100, discount: 0, tax: 18, cgst: 9, sgst: 9, total: 118
  });
});

test('an ineligible oversized flat coupon does not make the invoice total negative', function () {
  var order = billedOrder([item({ price: 10 })], 'FLAT50');
  assert.equal(order.discount, 0);
  assert.equal(order.total, 11.8);
  assert.deepEqual(figures(invoice.computeInvoiceFigures(order)), {
    subtotal: 10, discount: 0, tax: 1.8, cgst: 0.9, sgst: 0.9, total: 11.8
  });
});

test('invoice sums rounded line taxes consistently with billing', function () {
  var items = [item({ price: 0.03 }), item({ id: 2, price: 0.03 })];
  var billed = pricing.computeTotals(items, '');
  var calculated = invoice.computeInvoiceFigures(billedOrder(items));
  assert.deepEqual(figures(billed), {
    subtotal: 0.06, discount: 0, tax: 0.02, cgst: 0.01, sgst: 0.01, total: 0.08
  });
  assert.deepEqual(calculated.rows.map(function (row) { return row.lineTax; }), [0.01, 0.01]);
  assert.deepEqual(figures(calculated), {
    subtotal: 0.06, discount: 0, tax: 0.02, cgst: 0.01, sgst: 0.01, total: 0.08
  });
});

test('CURRENT BEHAVIOUR: invoice recomputes figures instead of using stored billed aggregates', function () {
  var order = billedOrder([item({ hsn: '1006' })]);
  order.subtotal = 999;
  order.discount = 777;
  order.tax = 888;
  order.total = 9999;
  assert.deepEqual(figures(invoice.computeInvoiceFigures(order)), {
    subtotal: 100, discount: 0, tax: 5, cgst: 2.5, sgst: 2.5, total: 105
  });
});

test('rendered invoice shows billed HSN amounts without a mismatch notice', function () {
  var order = billedOrder([item({ hsn: '1006' })]);
  var html = invoice.render(order);
  assert.equal(order.tax, 5);
  assert.equal(order.total, 105);
  assert.ok(html.includes('<td class="r">5%</td>'));
  assert.ok(html.includes('<tr><td>CGST + SGST (Total GST)</td><td class="r">₹5.00</td></tr>'));
  assert.ok(html.includes('<tr class="grand"><td>Invoice Total</td><td class="r">₹105.00</td></tr>'));
  assert.ok(!html.includes('Accountant Reconciliation Notice:'));
});

test('rendered percentage-coupon invoice shows billed GST and the existing combined GST row', function () {
  var order = billedOrder([item({ price: 1000 })], 'SAVE10');
  var html = invoice.render(order);
  assert.equal(order.tax, 162);
  assert.equal(order.total, 1062);
  assert.ok(html.includes('<tr><td>CGST + SGST (Total GST)</td><td class="r">₹162.00</td></tr>'));
  assert.ok(html.includes('<tr class="grand"><td>Invoice Total</td><td class="r">₹1062.00</td></tr>'));
  assert.ok(!html.includes('Accountant Reconciliation Notice:'));
  assert.ok(!html.includes('<tr><td>CGST</td>'));
  assert.ok(!html.includes('<tr><td>SGST</td>'));
});

test('matching rendered invoice omits the reconciliation notice', function () {
  var html = invoice.render(billedOrder([item()]));
  assert.ok(html.includes('<tr class="grand"><td>Invoice Total</td><td class="r">₹118.00</td></tr>'));
  assert.ok(!html.includes('Accountant Reconciliation Notice:'));
});

test('GST reconciliation matches billed and invoice figures for an HSN-rated order', function () {
  var order = billedOrder([item({ hsn: '1006' })]);
  assert.deepEqual(reports.getGstReconciliation({ orders: [order] }), {
    totalChecked: 1,
    mismatchCount: 0,
    totalDelta: 0,
    rows: [{
      orderId: 1,
      date: '26/11/2026',
      customer: 'Synthetic customer',
      coupon: '',
      ledgerSubtotal: 100,
      ledgerDiscount: 0,
      ledgerTax: 5,
      ledgerTotal: 105,
      invoiceDiscount: 0,
      invoiceTax: 5,
      invoiceTotal: 105,
      delta: 0,
      matched: true
    }]
  });
});

test('GST reconciliation matches the discounted GST as well as the percentage-coupon total', function () {
  var order = billedOrder([item({ price: 1000 })], 'SAVE10');
  var reconciliation = reports.getGstReconciliation({ orders: [order] });
  assert.equal(reconciliation.totalChecked, 1);
  assert.equal(reconciliation.mismatchCount, 0);
  assert.equal(reconciliation.totalDelta, 0);
  assert.equal(reconciliation.rows[0].ledgerTax, 162);
  assert.equal(reconciliation.rows[0].invoiceTax, 162);
  assert.equal(reconciliation.rows[0].ledgerTotal, 1062);
  assert.equal(reconciliation.rows[0].invoiceTotal, 1062);
  assert.equal(reconciliation.rows[0].delta, 0);
  assert.equal(reconciliation.rows[0].matched, true);
});

test('GST reconciliation marks an undiscounted 18% invoice as matched', function () {
  var reconciliation = reports.getGstReconciliation({ orders: [billedOrder([item()])] });
  assert.equal(reconciliation.totalChecked, 1);
  assert.equal(reconciliation.mismatchCount, 0);
  assert.equal(reconciliation.totalDelta, 0);
  assert.equal(reconciliation.rows[0].ledgerTax, 18);
  assert.equal(reconciliation.rows[0].invoiceTax, 18);
  assert.equal(reconciliation.rows[0].ledgerTotal, 118);
  assert.equal(reconciliation.rows[0].invoiceTotal, 118);
  assert.equal(reconciliation.rows[0].matched, true);
});

test('invoice matches billed totals and line GST for mixed HSN rates with a capped coupon', function () {
  var order = billedOrder([
    item({ id: 1, hsn: '1006', price: 1000 }),
    item({ id: 2, hsn: '0405', price: 1000 }),
    item({ id: 3, hsn: '0902', price: 1000 })
  ], 'SAVE10');
  assert.deepEqual([order.subtotal, order.discount, order.tax, order.total], [3000, 150, 332.5, 3182.5]);
  var calculated = invoice.computeInvoiceFigures(order);
  assert.deepEqual(figures(calculated), {
    subtotal: 3000, discount: 150, tax: 332.5, cgst: 166.25, sgst: 166.25, total: 3182.5
  });
  assert.deepEqual(calculated.rows.map(function (row) {
    return [row.gstPercent, row.lineTax];
  }), [[5, 47.5], [12, 114], [18, 171]]);
  var html = invoice.render(order);
  assert.ok(html.includes('<tr class="grand"><td>Invoice Total</td><td class="r">₹3182.50</td></tr>'));
  assert.ok(html.includes('<tr><td>CGST + SGST (Total GST)</td><td class="r">₹332.50</td></tr>'));
  assert.ok(!html.includes('Accountant Reconciliation Notice:'));
});

test('invoice preserves the CGST/SGST remainder for an odd paisa of GST', function () {
  var calculated = invoice.computeInvoiceFigures(billedOrder([item({ hsn: '1006', price: 0.1 })]));
  assert.deepEqual(figures(calculated), {
    subtotal: 0.1, discount: 0, tax: 0.01, cgst: 0.01, sgst: 0, total: 0.11
  });
  assert.equal(calculated.rows[0].lineTax, 0.01);
});

test('CURRENT BEHAVIOUR: inconsistent stored totals still produce a reconciliation notice', function () {
  var order = billedOrder([item({ hsn: '1006' })]);
  order.total = 104;
  var html = invoice.render(order);
  assert.ok(html.includes('Invoice computed total (₹105.00) differs from Order Ledger recorded total (₹104.00) by +₹1.00.'));
  var reconciliation = reports.getGstReconciliation({ orders: [order] });
  assert.equal(reconciliation.mismatchCount, 1);
  assert.equal(reconciliation.totalDelta, 1);
  assert.equal(reconciliation.rows[0].matched, false);
});

test('CURRENT BEHAVIOUR: a stored GST-only discrepancy is flagged by the report but not the invoice notice', function () {
  var order = billedOrder([item({ price: 1000 })], 'SAVE10');
  order.tax = 161;
  assert.ok(!invoice.render(order).includes('Accountant Reconciliation Notice:'));
  var reconciliation = reports.getGstReconciliation({ orders: [order] });
  assert.equal(reconciliation.mismatchCount, 1);
  assert.equal(reconciliation.totalDelta, 0);
  assert.equal(reconciliation.rows[0].ledgerTax, 161);
  assert.equal(reconciliation.rows[0].invoiceTax, 162);
  assert.equal(reconciliation.rows[0].ledgerTotal, 1062);
  assert.equal(reconciliation.rows[0].invoiceTotal, 1062);
  assert.equal(reconciliation.rows[0].matched, false);
});
