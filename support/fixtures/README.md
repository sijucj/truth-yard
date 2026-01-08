# Test Fixtures use by `*_test.ts` regression suite

This directory houses non-sensitive "test fixture" files that are used by test
suites. Do not change the name of files without checking the test sources.

- `scf-2025.3.sqlite.db` (SQLPage SQLite): SCF database with `sqlpage_files`
  table.
- `empty-rssd.sqlite.db` (`surveilr` v3.20 SQLite): An empty SQLite file created
  by `surveilr admin init`.
- `sakila.db` (SQLite): The Sakila sample database was initially developed by
  Mike Hillyer, a former member of the MySQL AB documentation team. It is
  intended to provide a standard schema that can be used for examples in books,
  tutorials, articles, samples, and so forth.
- `chinook.db` (SQLite): Chinook is a sample database available for SQL Server,
  Oracle, MySQL, etc. It can be created by running a single SQL script. Chinook
  database is an alternative to the Northwind database, being ideal for demos
  and testing ORM tools targeting single and multiple database servers.
- northwind.sqlite.db (SQLite): The Northwind sample database was provided with
  Microsoft Access as a tutorial schema for managing small business customers,
  orders, inventory, purchasing, suppliers, shipping, and employees.
  `northwind.sqlite.db` is an excellent _abridged_ tutorial schema for a
  small-business ERP, with customers, orders, inventory, purchasing, suppliers,
  shipping, employees, and single-entry accounting. Original unabridged source:
  https://github.com/jpwhite3/northwind-SQLite3
- `northwind.xlsx` (Excel): The Northwind sample database in Excel.
- `sample.duckdb` (DuckDB): From https://www.timestored.com/data/sample/duckdb
