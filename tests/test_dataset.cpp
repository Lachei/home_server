#include "test_util.hpp"
#include "../src/Database.hpp"

int test_database_store_load() {

    return result::success;
}

int main() {
    check_res(test_database_store_load());

    return result::success;
}