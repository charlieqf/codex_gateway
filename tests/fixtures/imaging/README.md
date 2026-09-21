These self-signed localhost certificate/key fixtures are public test material,
generated solely for the imaging HTTPS tests. They contain no production identity
or secret and must never be installed on R760 or star. The SANs intentionally
allow localhost/127.0.0.1 and reject 127.0.0.2 in the hostname-validation test.
