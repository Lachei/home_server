#include "test_util.hpp"
#include "../src/Database.hpp"

namespace result {
    static constexpr int storage_error = 1;
}

int test_database_store_load() {
    try{
        Database::Table::ColumnInfos column_infos{
            .column_names = {"id", "string", "double", "time", "byte"},
            .id_column = 0u
        };

        Database test("data/test");
        //test.create_table("test_table", );
        //test.insert_rows("test_table");
    } catch(std::runtime_error e) {
        std::cout << "[Error data store] " << e.what() << std::endl;
        return result::storage_error;
    }

    return result::success;
}

int main() {
    check_res(test_database_store_load());

    return result::success;
}