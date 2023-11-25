#include "utils.hpp"
#include "../src/util.hpp"

int main() {
    std::cout << to_date_string(std::chrono::system_clock::now()) << std::endl;

    return result::success;
}