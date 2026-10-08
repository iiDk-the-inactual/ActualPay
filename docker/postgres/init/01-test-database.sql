-- Separate database for integration tests. The test harness refuses to run
-- against any database whose name does not end in _test.
CREATE DATABASE actualpay_test OWNER actualpay;
