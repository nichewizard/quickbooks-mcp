/**
 * Invoice API response fixtures for testing.
 */

export const sampleInvoice = {
  Id: '456',
  SyncToken: '0',
  DocNumber: 'INV-001',
  TxnDate: '2024-01-15',
  DueDate: '2024-02-15',
  CustomerRef: {
    value: '123',
    name: 'Test Customer',
  },
  Line: [
    {
      Id: '1',
      LineNum: 1,
      Description: 'Consulting Services',
      Amount: 500.0,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: {
          value: '1',
          name: 'Consulting',
        },
        Qty: 5,
        UnitPrice: 100.0,
      },
    },
    {
      Amount: 500.0,
      DetailType: 'SubTotalLineDetail',
      SubTotalLineDetail: {},
    },
  ],
  TotalAmt: 500.0,
  Balance: 500.0,
  EmailStatus: 'NotSet',
  PrintStatus: 'NotSet',
  BillEmail: {
    Address: 'test@example.com',
  },
  MetaData: {
    CreateTime: '2024-01-15T00:00:00-08:00',
    LastUpdatedTime: '2024-01-15T00:00:00-08:00',
  },
};

export const sampleInvoiceList = [
  sampleInvoice,
  {
    ...sampleInvoice,
    Id: '457',
    DocNumber: 'INV-002',
    TotalAmt: 1000.0,
    Balance: 1000.0,
  },
];

export const invoiceQueryResponse = {
  QueryResponse: {
    Invoice: sampleInvoiceList,
    startPosition: 1,
    maxResults: 2,
  },
};
