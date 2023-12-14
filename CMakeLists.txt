cmake_minimum_required(VERSION 3.15.0 FATAL_ERROR)
project(home_server)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED TRUE)

find_package(Boost COMPONENTS REQUIRED)

file(GLOB SRC "src/*")
if(WIN32)
    add_compile_definitions(_WIN32_WINNT=0x0601)
else()
    add_compile_options(-fpermissive)
endif()
include_directories(${Boost_INCLUDE_DIR})
add_executable(home_server ${SRC})
target_link_libraries(home_server PRIVATE -static Boost::boost Boost::headers)

include(CTest)
add_subdirectory(tests)