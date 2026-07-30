/**
 * Customer API response fixtures for testing.
 */

export const sampleCustomer = {
  Id: '123',
  SyncToken: '0',
  DisplayName: 'Test Customer',
  GivenName: 'Test',
  FamilyName: 'Customer',
  CompanyName: 'Test Company Inc',
  PrimaryEmailAddr: {
    Address: 'test@example.com',
  },
  PrimaryPhone: {
    FreeFormNumber: '555-1234',
  },
  BillAddr: {
    Line1: '123 Main St',
    City: 'San Francisco',
    CountrySubDivisionCode: 'CA',
    PostalCode: '94105',
  },
  Balance: 0,
  Active: true,
  MetaData: {
    CreateTime: '2024-01-01T00:00:00-08:00',
    LastUpdatedTime: '2024-01-01T00:00:00-08:00',
  },
};

export const sampleCustomerList = [
  sampleCustomer,
  {
    ...sampleCustomer,
    Id: '124',
    DisplayName: 'Another Customer',
  },
];

export const customerQueryResponse = {
  QueryResponse: {
    Customer: sampleCustomerList,
    startPosition: 1,
    maxResults: 2,
  },
};
